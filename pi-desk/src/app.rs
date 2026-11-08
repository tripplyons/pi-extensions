//! Window state, messages, and the update loop. Agent logic lives in
//! [`Desk`]; this module turns its effects into processes and git jobs, and
//! turns input into desk actions. [`spec`] wires it into a Rune window.

use crate::desk::{Desk, Effect, Isolation};
use crate::git::{self, FileDiff, Merge};
use crate::goal::{self, Goal};
use crate::icon::{ALT, COMMAND, Icon, KeyPart};
use crate::later;
use crate::model::*;
use crate::order;
use crate::store::Store;
use crate::supervisor::{self, Request};
use crate::swarm::{self, Worker};
use crate::task::{Inbox, Task, Ui};
use crate::vim::Target;
use crate::{commit_message, compose};
use rune::{Key, KeyEvent, TextEdit, Tx};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const UNDO_WINDOW: Duration = Duration::from_secs(5);
/// How often goals and swarm workers are read again while tasks exist.
pub const WATCH_EVERY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum View {
    All,
    Inbox,
    Working,
    Later,
    Done,
    Project(Id),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Diff,
    Transcript,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deferred {
    Merge,
    Discard,
    MarkDone,
}

impl Deferred {
    fn verb(self) -> &'static str {
        match self {
            Deferred::Merge => "Merging",
            Deferred::Discard => "Discarding",
            Deferred::MarkDone => "Closing",
        }
    }
}

/// A destructive action waiting out its undo window.
#[derive(Debug, Clone)]
pub struct Pending {
    pub id: Id,
    pub action: Deferred,
    pub due: Instant,
    pub label: String,
}

pub struct Composer {
    pub history: crate::composer_edit::History,
    pub project: Option<Id>,
    /// The branch new tasks merge into: the project's current branch.
    pub base: Result<String, String>,
    /// Off: tasks work in the project's own checkout.
    pub use_worktree: bool,
    pub session: SessionPicker,
    pub content: TextEdit,
    pub vim: crate::vim::Vim,
    pub error: Option<String>,
    /// Open while Cmd+P fuzzy project search is shown.
    pub project_search: Option<ProjectSearch>,
    /// The project menu is open.
    pub picking_project: bool,
}

#[derive(Debug, Default)]
pub struct ProjectSearch {
    pub query: TextEdit,
    /// Index into [`App::project_matches`].
    pub selected: usize,
}

#[derive(Default)]
pub struct SessionPicker {
    pub settings: SessionSettings,
    pub options: Option<crate::models::Options>,
    pub loading: bool,
    pub error: Option<String>,
    request: u64,
    requested: Option<SessionSettings>,
}

pub struct Palette {
    pub query: TextEdit,
    pub selected: usize,
}

pub struct LaterPicker {
    pub agent: Id,
    pub custom: TextEdit,
    pub error: Option<String>,
}

pub struct SettingsForm {
    pub slots: TextEdit,
    pub terminal: TextEdit,
    pub editor: TextEdit,
    pub vim_mode: bool,
    pub vim_escape: TextEdit,
    pub error: Option<String>,
}

pub enum Overlay {
    Composer(Composer),
    Palette(Palette),
    Later(LaterPicker),
    Settings(SettingsForm),
    ConfirmDiscard(Id),
}

/// Syntax colors for the shown lines of one diff file.
pub type FileColors = Arc<Vec<crate::highlight::Spans>>;

pub struct DiffState {
    pub files: Result<Arc<Vec<FileDiff>>, String>,
    /// Syntax colors by file index. Only files shown in the Diff tab get
    /// colors, computed off the UI thread.
    pub colors: HashMap<usize, FileColors>,
    pub selected: usize,
    pub loading: bool,
    /// The file index being highlighted off the UI thread.
    highlighting: Option<usize>,
}

impl Default for DiffState {
    fn default() -> Self {
        DiffState {
            files: Ok(Arc::default()),
            colors: HashMap::new(),
            selected: 0,
            loading: false,
            highlighting: None,
        }
    }
}

/// A diff's files and the colors computed for them so far.
pub type DiffColors = (Arc<Vec<FileDiff>>, HashMap<usize, FileColors>);

/// A diff parsed off the UI thread.
#[derive(Debug, Clone)]
pub struct LoadedDiff {
    pub files: Arc<Vec<FileDiff>>,
    /// Colors kept from the previous load for files that did not change.
    pub colors: HashMap<usize, FileColors>,
}

impl LoadedDiff {
    /// Parses `text`. When the files match `previous`, its files and colors
    /// are kept as they are, so nothing is parsed or highlighted again.
    pub fn parse(text: &str, previous: Option<DiffColors>) -> LoadedDiff {
        let files = git::parse_diff(text);
        let Some((old_files, old_colors)) = previous else {
            return LoadedDiff {
                files: Arc::new(files),
                colors: HashMap::new(),
            };
        };
        if *old_files == files {
            return LoadedDiff {
                files: old_files,
                colors: old_colors,
            };
        }
        let old_index: HashMap<&str, usize> = old_files
            .iter()
            .enumerate()
            .map(|(index, file)| (file.path.as_str(), index))
            .collect();
        let colors = files
            .iter()
            .enumerate()
            .filter_map(|(index, file)| {
                let old = *old_index.get(file.path.as_str())?;
                (old_files[old].lines == file.lines)
                    .then(|| old_colors.get(&old).cloned())
                    .flatten()
                    .map(|colors| (index, colors))
            })
            .collect();
        LoadedDiff {
            files: Arc::new(files),
            colors,
        }
    }
}

/// Which model menu is open: a task's, or the composer's (`None`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Menu {
    Model(Option<Id>),
    Effort(Option<Id>),
}

/// What the last background read found for one task.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Watched {
    /// The latest saved goal, whatever its status.
    pub goal: Option<Goal>,
    pub workers: Vec<Worker>,
}

/// One task as the background read needs it.
#[derive(Debug, Clone)]
pub struct WatchItem {
    pub id: Id,
    pub session: String,
    pub file: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub enum Message {
    Supervisor(supervisor::Event),
    Tick,
    /// A key the focused field passed on, or any key with nothing focused.
    Key {
        event: KeyEvent,
        captured: bool,
    },
    /// The project drag ended.
    MouseReleased,
    /// A file dragged onto the window, such as a screenshot.
    FileDropped(PathBuf),
    Show(View),
    Select(Id),
    Open(Id),
    ToggleFocus,
    SetTab(Tab),
    ToggleSidebar,
    ZoomIn,
    ZoomOut,
    ResetZoom,
    /// The card's numbered choice at this 0-based index.
    Choose(usize),
    Answer(usize),
    Approve,
    StartReply,
    /// The reply box's text changed in the field itself.
    ReplyEdited,
    Vim(Target, crate::vim::Input),
    /// Clipboard text for a vim put: after the cursor, and how many times.
    VimPut(Target, bool, usize, Option<String>),
    /// Undo or redo in a vim-mode box (true is undo).
    VimHistory(Target, bool),
    SendReply,
    CancelReply,
    NewTask,
    ComposerProject(Id),
    ComposerProjectMenu,
    ComposerProjectSearch,
    ComposerProjectQuery(String),
    /// Pick the match at this index in [`App::project_matches`].
    ComposerProjectPick(usize),
    ToggleMenu(Menu),
    CloseMenu,
    SessionModel(Option<Id>, ModelChoice),
    SessionEffort(Option<Id>, String),
    RefreshSession(Option<Id>),
    SessionLoaded(
        Option<Id>,
        u64,
        bool,
        Result<crate::models::Options, String>,
    ),
    /// The composer's text changed in the field itself.
    ComposerEdited,
    ComposerSubmit,
    ComposerWorktree(bool),
    CloseOverlay,
    OpenPalette,
    PaletteQuery(String),
    PaletteRun(usize),
    OpenLater,
    LaterPreset(later::Preset),
    LaterCustom(String),
    LaterSubmit,
    WakeNow,
    Discard,
    ConfirmDiscard,
    MarkDone,
    Retry,
    Undo,
    AddProject,
    ProjectPicked(Option<PathBuf>),
    MoveProject(Id, isize),
    DragProject(Id),
    HoverProject(usize),
    OpenTerminal,
    OpenEditor,
    /// A transcript read from a task's session file off the UI thread.
    TranscriptRead(Id, Option<Arc<crate::transcript::Transcript>>),
    DiffLoaded(Id, Result<LoadedDiff, String>),
    /// Syntax colors for file `index` of the diff `files`.
    DiffHighlighted {
        id: Id,
        files: Arc<Vec<FileDiff>>,
        index: usize,
        colors: FileColors,
    },
    SelectFile(usize),
    ToggleTool(String),
    ToggleThinking(String, usize, usize),
    WorktreeCreated(Id, Result<(), String>),
    CommitMessageGenerated(Id, Result<Option<String>, String>),
    Merged(Id, Result<Merge, String>),
    Removed(Id, Outcome, Result<(), String>),
    /// Goals and swarm workers read off the UI thread, by task.
    Watched(HashMap<Id, Watched>),
    OpenSettings,
    SettingsSlots(String),
    SettingsTerminal(String),
    SettingsEditor(String),
    SettingsVim(bool),
    SettingsVimEscape(String),
    SaveSettings,
    DismissError,
    Link(String),
}

pub struct App {
    pub desk: Desk,
    pub store: Store,
    save_enabled: bool,
    supervisor: Option<supervisor::Handle>,
    backlog: Vec<Request>,
    pub view: View,
    pub focus: bool,
    pub selected: Option<Id>,
    pub tab: Tab,
    pub show_sidebar: bool,
    // Window-only preference. Never written to saved state.
    zoom_percent: u16,
    pub replying: bool,
    pub reply: TextEdit,
    reply_history: crate::composer_edit::History,
    pub reply_vim: crate::vim::Vim,
    pub overlay: Option<Overlay>,
    pub menu: Option<Menu>,
    pub pending: Vec<Pending>,
    pub diffs: HashMap<Id, DiffState>,
    /// Tasks whose session file is being read for a transcript.
    reading_transcripts: HashSet<Id>,
    pub sessions: HashMap<Id, SessionPicker>,
    next_session_request: u64,
    pub expanded: HashSet<String>,
    /// Task ID, assistant-message ID, and content-block index. UI state only.
    pub expanded_thinking: HashSet<(String, usize, usize)>,
    pub toast: Option<(String, Instant)>,
    pub error: Option<String>,
    pub dragging: Option<(Id, Option<usize>)>,
    pub now: Timestamp,
    /// Where the swarm extension keeps its runs.
    pub swarm_dir: PathBuf,
    pub watched: HashMap<Id, Watched>,
    followers: Arc<Mutex<HashMap<Id, goal::Follower>>>,
    watching: bool,
    last_watch: Option<Instant>,
    last_tick: Instant,
    /// The window's size in points, as last laid out.
    pub viewport: Option<(f32, f32)>,
    pub inbox: Inbox,
    ui: Vec<Ui>,
    /// The field that a focus-less accessor edits when its box is gone.
    scratch: TextEdit,
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    tokio::task::spawn_blocking(work)
        .await
        .expect("blocking task panicked")
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

pub struct PaletteCommand {
    pub label: String,
    pub keys: &'static [KeyPart<'static>],
    pub message: Message,
}

/// A numbered choice on a task card, picked by click or digit key.
pub struct Choice {
    pub label: String,
    pub recommended: bool,
    pub message: Message,
}

/// Question rows answer the question. Review and failed rows act on the task.
pub fn choices(agent: &Agent) -> Vec<Choice> {
    let actions = |actions: Vec<(&str, Message)>| {
        actions
            .into_iter()
            .enumerate()
            .map(|(index, (label, message))| Choice {
                label: label.into(),
                recommended: index == 0,
                message,
            })
            .collect()
    };
    match &agent.status {
        Status::Question => agent
            .question
            .iter()
            .flat_map(|question| {
                let recommended = question.recommended.unwrap_or(0);
                question
                    .choices
                    .iter()
                    .enumerate()
                    .map(move |(index, label)| Choice {
                        label: label.clone(),
                        recommended: index == recommended,
                        message: Message::Answer(index),
                    })
            })
            .collect(),
        Status::Review => actions(vec![
            ("Merge", Message::Approve),
            ("Send back with a reply", Message::StartReply),
            ("Discard", Message::Discard),
        ]),
        Status::Failed { .. } => actions(vec![
            ("Retry", Message::Retry),
            ("Discard", Message::Discard),
        ]),
        _ => Vec::new(),
    }
}

/// The text a plain key types, without Command or Control.
fn typed(event: &KeyEvent) -> Option<&str> {
    match &event.key {
        Key::Text(text) if !event.mods.cmd && !event.mods.ctrl => Some(text.as_str()),
        _ => None,
    }
}

/// The character typed with the primary shortcut modifier.
pub fn command_char(event: &KeyEvent) -> Option<char> {
    match &event.key {
        Key::Command(c) => Some(c.to_ascii_lowercase()),
        Key::Text(text) if event.mods.cmd => text.chars().next().map(|c| c.to_ascii_lowercase()),
        _ => None,
    }
}

fn edit_text(edit: &mut TextEdit, value: String) {
    if edit.text != value {
        edit.replace_text(value);
    }
}

fn focused(text: &str) -> TextEdit {
    let mut edit = TextEdit::new(text);
    edit.focused = true;
    edit
}

impl App {
    pub fn boot() -> App {
        let pi = std::env::var("PI_DESK_PI").unwrap_or_else(|_| "pi".into());
        App::new(Store::default_location(), pi)
    }

    /// Loads saved state from `store`. Agents start once the supervisor
    /// reports ready.
    pub fn new(store: Store, pi: impl Into<String>) -> App {
        let (state, error) = match store.load() {
            Ok(state) => (state, None),
            Err(error) => (
                State::default(),
                Some(format!(
                    "Could not read saved state, so nothing will be saved this run: {error}"
                )),
            ),
        };
        let desk = Desk::new(state, pi, store.worktrees());
        let mut app = App {
            desk,
            // A corrupt state file must not be overwritten.
            save_enabled: error.is_none(),
            store,
            supervisor: None,
            backlog: Vec::new(),
            view: View::All,
            focus: false,
            selected: None,
            tab: Tab::Transcript,
            show_sidebar: true,
            zoom_percent: 100,
            replying: false,
            reply: TextEdit::new(""),
            reply_history: Default::default(),
            reply_vim: Default::default(),
            overlay: None,
            menu: None,
            pending: Vec::new(),
            diffs: HashMap::new(),
            reading_transcripts: HashSet::new(),
            sessions: HashMap::new(),
            next_session_request: 0,
            expanded: HashSet::new(),
            expanded_thinking: HashSet::new(),
            toast: None,
            error,
            dragging: None,
            now: now(),
            swarm_dir: crate::store::agent_dir().join("swarm"),
            watched: HashMap::new(),
            followers: Arc::default(),
            watching: false,
            last_watch: None,
            last_tick: Instant::now(),
            viewport: None,
            inbox: Inbox::default(),
            ui: Vec::new(),
            scratch: TextEdit::new(""),
        };
        // Selecting the first task reads its transcript and diff in the
        // background; that work must start, or the task stays loading.
        let task = app.ensure_selection();
        app.start(task);
        app
    }

    /// Additional UI scale on top of the display's.
    pub fn scale_factor(&self) -> f32 {
        f32::from(self.zoom_percent) / 100.0
    }

    /// The goal to show for a task: active or paused, never finished.
    pub fn goal(&self, id: &str) -> Option<Goal> {
        goal::shown(
            self.watched.get(id).and_then(|watched| watched.goal.as_ref()),
            self.desk.goal_active(id),
        )
    }

    /// The task's active swarm workers, nested depth first.
    pub fn workers(&self, id: &str) -> &[Worker] {
        self.watched
            .get(id)
            .map(|watched| watched.workers.as_slice())
            .unwrap_or_default()
    }

    /// Reads every task's goal and swarm workers off the UI thread. Returns
    /// nothing while a read is running or no task exists.
    pub fn watch(&mut self) -> Task {
        if self.watching || self.desk.state.agents.is_empty() {
            return Task::none();
        }
        self.watching = true;
        self.last_watch = Some(Instant::now());
        let items: Vec<WatchItem> = self
            .desk
            .state
            .agents
            .iter()
            .map(|agent| WatchItem {
                id: agent.id.clone(),
                session: agent.session_id.clone(),
                file: agent.session_file.clone(),
            })
            .collect();
        let dir = self.swarm_dir.clone();
        let followers = self.followers.clone();
        Task::perform(
            blocking(move || read_watched(&dir, &items, &followers)),
            Message::Watched,
        )
    }

    /// Rows of the current view, in display order. The selected task keeps
    /// its row after it stops matching the view, until the user selects
    /// another task or changes views.
    pub fn rows(&self) -> Vec<&Agent> {
        let mut rows: Vec<&Agent> = self
            .desk
            .state
            .agents
            .iter()
            .filter(|agent| !self.hidden(&agent.id))
            .filter(|agent| {
                self.selected.as_ref() == Some(&agent.id) || self.in_view(agent, &self.view)
            })
            .collect();
        rows.sort_by(|a, b| order::compare_display(a, b, self.now));
        rows
    }

    /// Whether a task matches a view's filter.
    fn in_view(&self, agent: &Agent, view: &View) -> bool {
        match view {
            View::All => true,
            View::Inbox => agent.in_inbox(self.now),
            View::Working => {
                matches!(agent.status, Status::Working | Status::Queued) && !agent.snoozed(self.now)
            }
            View::Later => agent.snoozed(self.now) && !agent.status.is_done(),
            View::Done => agent.status.is_done(),
            View::Project(id) => &agent.project_id == id && !agent.status.is_done(),
        }
    }

    /// Tasks waiting out an undo window are hidden everywhere, except the
    /// selected task, which stays listed and open.
    pub fn hidden(&self, id: &str) -> bool {
        self.selected.as_deref() != Some(id) && self.is_pending(id)
    }

    fn is_pending(&self, id: &str) -> bool {
        self.pending.iter().any(|pending| pending.id == id)
    }

    /// Visible tasks that match a view's filter.
    pub fn count(&self, view: &View) -> usize {
        self.desk
            .state
            .agents
            .iter()
            .filter(|agent| !self.is_pending(&agent.id) && self.in_view(agent, view))
            .count()
    }

    pub fn current(&self) -> Option<&Agent> {
        let id = self.selected.as_ref()?;
        if self.hidden(id) {
            return None;
        }
        self.desk.state.agent(id)
    }

    fn ensure_selection(&mut self) -> Task {
        let rows = self.rows();
        let keep = self
            .selected
            .as_ref()
            .is_some_and(|id| rows.iter().any(|agent| &agent.id == id));
        if !keep {
            let next = rows.first().map(|agent| agent.id.clone());
            if next != self.selected {
                return self.select(next);
            }
        }
        Task::none()
    }

    fn select(&mut self, id: Option<Id>) -> Task {
        if self.selected == id {
            return Task::none();
        }
        self.selected = id.clone();
        self.replying = false;
        let Some(id) = id else {
            // Otherwise focus mode would reappear when a task is next selected.
            self.focus = false;
            return Task::none();
        };
        let transcript = self.read_transcript(&id);
        let cached = self.sessions.get(&id).is_some_and(|picker| {
            (picker.options.is_some() || picker.loading)
                && self.desk.state.agent(&id).is_some_and(|agent| {
                    picker.settings == agent.session_settings
                        || picker.requested.as_ref() == Some(&agent.session_settings)
                })
        });
        let models = if cached {
            Task::none()
        } else {
            self.load_session(Some(id.clone()), None)
        };
        let reveal = Task::ui(Ui::Reveal(crate::views::row_key(&id)));
        Task::batch([transcript, self.load_diff(&id), models, reveal])
    }

    /// Whether a task's transcript is still being read from its session file.
    pub fn reading_transcript(&self, id: &str) -> bool {
        self.reading_transcripts.contains(id)
    }

    /// Reads a task's transcript from its session file off the UI thread.
    /// Session files of long tasks are tens of megabytes.
    fn read_transcript(&mut self, id: &str) -> Task {
        let Some(file) = self.desk.unloaded_transcript(id) else {
            return Task::none();
        };
        if !self.reading_transcripts.insert(id.to_string()) {
            return Task::none();
        }
        let id = id.to_string();
        Task::perform(
            blocking(move || {
                crate::transcript::Transcript::from_session_file(&file)
                    .ok()
                    .map(Arc::new)
            }),
            move |transcript| Message::TranscriptRead(id.clone(), transcript),
        )
    }

    fn row_ids(&self) -> Vec<Id> {
        self.rows().iter().map(|agent| agent.id.clone()).collect()
    }

    fn move_selection(&mut self, delta: isize) -> Task {
        let rows = self.row_ids();
        if rows.is_empty() {
            return Task::none();
        }
        let index = self
            .selected
            .as_ref()
            .and_then(|id| rows.iter().position(|row| row == id));
        let next = match index {
            Some(index) => (index as isize + delta).clamp(0, rows.len() as isize - 1) as usize,
            None => 0,
        };
        self.select(Some(rows[next].clone()))
    }

    fn supervise(&mut self, request: Request) {
        match &self.supervisor {
            Some(handle) => handle.send(request),
            None => self.backlog.push(request),
        }
    }

    fn run(&mut self, effects: Vec<Effect>) -> Task {
        let mut tasks = Vec::new();
        for effect in effects {
            match effect {
                Effect::Spawn(spawn) => self.supervise(Request::Spawn(spawn)),
                Effect::Send { agent, line } => self.supervise(Request::Send { agent, line }),
                Effect::Close { agent } => self.supervise(Request::Close { agent }),
                Effect::Kill { agent } => self.supervise(Request::Kill { agent }),
                Effect::CreateWorktree {
                    agent,
                    repo,
                    path,
                    branch,
                    base,
                } => tasks.push(Task::perform(
                    blocking(move || git::add_worktree(&repo, &path, &branch, &base)),
                    move |result| Message::WorktreeCreated(agent.clone(), result),
                )),
                Effect::GenerateCommitMessage {
                    agent,
                    program,
                    worktree,
                    base,
                    title,
                    summary,
                } => tasks.push(Task::perform(
                    async move {
                        commit_message::generate(&program, &worktree, &base, &title, &summary).await
                    },
                    move |result| Message::CommitMessageGenerated(agent.clone(), result),
                )),
                Effect::Commit {
                    agent,
                    checkout,
                    base,
                    message,
                } => tasks.push(Task::perform(
                    blocking(move || git::commit_checkout(&checkout, &base, &message)),
                    move |result| Message::Merged(agent.clone(), result),
                )),
                Effect::Merge {
                    agent,
                    repo,
                    worktree,
                    branch,
                    base,
                    message,
                } => tasks.push(Task::perform(
                    blocking(move || git::squash_merge(&repo, &worktree, &branch, &base, &message)),
                    move |result| Message::Merged(agent.clone(), result),
                )),
                Effect::Remove {
                    agent,
                    repo,
                    worktree,
                    branch,
                    keep_branch,
                    outcome,
                } => tasks.push(Task::perform(
                    blocking(move || git::remove(&repo, &worktree, &branch, keep_branch)),
                    move |result| Message::Removed(agent.clone(), outcome, result),
                )),
            }
        }
        Task::batch(tasks)
    }

    fn load_diff(&mut self, id: &str) -> Task {
        let Some(agent) = self.desk.state.agent(id) else {
            return Task::none();
        };
        if !agent.workspace.path().exists() {
            return Task::none();
        }
        let (worktree, base) = (
            agent.workspace.path().to_path_buf(),
            agent.diff_base().to_string(),
        );
        let entry = self.diffs.entry(id.to_string()).or_default();
        if entry.loading {
            return Task::none();
        }
        entry.loading = true;
        let previous = entry
            .files
            .as_ref()
            .ok()
            .map(|files| (files.clone(), entry.colors.clone()));
        let id = id.to_string();
        // Large diffs take a second or more to parse and highlight, so none
        // of that runs on the UI thread.
        Task::perform(
            blocking(move || {
                git::diff(&worktree, &base).map(|text| LoadedDiff::parse(&text, previous))
            }),
            move |result| Message::DiffLoaded(id.clone(), result),
        )
    }

    /// Highlights the file shown in the Diff tab off the UI thread, once.
    fn highlight_shown(&mut self) -> Task {
        if self.tab != Tab::Diff {
            return Task::none();
        }
        let Some(id) = self.selected.clone() else {
            return Task::none();
        };
        let Some(state) = self.diffs.get_mut(&id) else {
            return Task::none();
        };
        let Ok(files) = &state.files else {
            return Task::none();
        };
        if files.is_empty() {
            return Task::none();
        }
        let index = state.selected.min(files.len() - 1);
        if state.colors.contains_key(&index) || state.highlighting == Some(index) {
            return Task::none();
        }
        state.highlighting = Some(index);
        let files = files.clone();
        Task::perform(
            blocking(move || {
                let file = &files[index];
                let colors = Arc::new(crate::highlight::diff_lines(&file.path, &file.lines));
                (files, colors)
            }),
            move |(files, colors)| Message::DiffHighlighted {
                id: id.clone(),
                files: files.clone(),
                index,
                colors: colors.clone(),
            },
        )
    }

    fn defer(&mut self, action: Deferred) -> Task {
        let Some(agent) = self.current() else {
            return Task::none();
        };
        let id = agent.id.clone();
        let label = format!("{} “{}”", action.verb(), agent.title);
        self.pending.retain(|pending| pending.id != id);
        self.pending.push(Pending {
            id,
            action,
            due: Instant::now() + UNDO_WINDOW,
            label,
        });
        Task::none()
    }

    /// Runs an action. The selected task stays selected whatever its new
    /// status; its row stays listed in the current view. A new action replaces any deferred one still waiting on the task.
    fn act(&mut self, id: &str, action: impl FnOnce(&mut Desk) -> Vec<Effect>) -> Task {
        self.pending.retain(|pending| pending.id != id);
        let effects = action(&mut self.desk);
        self.run(effects)
    }

    fn notify(&mut self, text: impl Into<String>) {
        self.toast = Some((text.into(), Instant::now()));
    }

    fn launch(&mut self, template: &str) {
        let Some(path) = self.current().and_then(|agent| self.desk.work_dir(agent)) else {
            return;
        };
        let command = template.replace("{path}", &shell_quote(&path.to_string_lossy()));
        if let Err(error) = std::process::Command::new("sh")
            .arg("-c")
            .arg(&command)
            .spawn()
        {
            self.error = Some(format!("Could not run `{command}`: {error}"));
        }
    }

    pub fn commands(&self) -> Vec<PaletteCommand> {
        let mut commands = vec![
            PaletteCommand {
                label: "New task".into(),
                keys: &[KeyPart::Text("N")],
                message: Message::NewTask,
            },
            PaletteCommand {
                label: "Add project…".into(),
                keys: &[],
                message: Message::AddProject,
            },
            PaletteCommand {
                label: "Show inbox".into(),
                keys: &[],
                message: Message::Show(View::Inbox),
            },
            PaletteCommand {
                label: "Show working".into(),
                keys: &[],
                message: Message::Show(View::Working),
            },
            PaletteCommand {
                label: "Show later".into(),
                keys: &[],
                message: Message::Show(View::Later),
            },
            PaletteCommand {
                label: "Show done".into(),
                keys: &[],
                message: Message::Show(View::Done),
            },
            PaletteCommand {
                label: "Show all tasks".into(),
                keys: &[],
                message: Message::Show(View::All),
            },
            PaletteCommand {
                label: if self.show_sidebar {
                    "Hide sidebar"
                } else {
                    "Show sidebar"
                }
                .into(),
                keys: &[KeyPart::Text("S")],
                message: Message::ToggleSidebar,
            },
            PaletteCommand {
                label: format!("Zoom in (current: {}%)", self.zoom_percent),
                keys: &[COMMAND, KeyPart::Text("+")],
                message: Message::ZoomIn,
            },
            PaletteCommand {
                label: format!("Zoom out (current: {}%)", self.zoom_percent),
                keys: &[COMMAND, KeyPart::Text("-")],
                message: Message::ZoomOut,
            },
            PaletteCommand {
                label: "Reset zoom to 100%".into(),
                keys: &[COMMAND, KeyPart::Text("0")],
                message: Message::ResetZoom,
            },
            PaletteCommand {
                label: if self.focus {
                    "Leave focus mode"
                } else {
                    "Focus mode"
                }
                .into(),
                keys: &[KeyPart::Text("F")],
                message: Message::ToggleFocus,
            },
            PaletteCommand {
                label: "Settings".into(),
                keys: &[],
                message: Message::OpenSettings,
            },
            PaletteCommand {
                label: "Undo".into(),
                keys: &[KeyPart::Text("Z")],
                message: Message::Undo,
            },
        ];
        for project in &self.desk.state.projects {
            commands.push(PaletteCommand {
                label: format!("Show project {}", project.name),
                keys: &[],
                message: Message::Show(View::Project(project.id.clone())),
            });
        }
        if let View::Project(id) = &self.view {
            commands.push(PaletteCommand {
                label: "Move project up".into(),
                keys: &[ALT, KeyPart::Icon(Icon::ArrowUp)],
                message: Message::MoveProject(id.clone(), -1),
            });
            commands.push(PaletteCommand {
                label: "Move project down".into(),
                keys: &[ALT, KeyPart::Icon(Icon::ArrowDown)],
                message: Message::MoveProject(id.clone(), 1),
            });
        }
        if let Some(agent) = self.current() {
            commands.push(PaletteCommand {
                label: "Reply".into(),
                keys: &[KeyPart::Text("R")],
                message: Message::StartReply,
            });
            if !agent.status.is_done() {
                commands.push(PaletteCommand {
                    label: "Later…".into(),
                    keys: &[KeyPart::Text("L")],
                    message: Message::OpenLater,
                });
                commands.push(PaletteCommand {
                    label: "Discard".into(),
                    keys: &[KeyPart::Text("X")],
                    message: Message::Discard,
                });
                commands.push(PaletteCommand {
                    label: "Mark done (keep branch)".into(),
                    keys: &[],
                    message: Message::MarkDone,
                });
            }
            match agent.status {
                Status::Question => commands.push(PaletteCommand {
                    label: "Answer with the recommended choice".into(),
                    keys: &[KeyPart::Text("E")],
                    message: Message::Approve,
                }),
                Status::Review => commands.push(PaletteCommand {
                    label: "Merge".into(),
                    keys: &[KeyPart::Text("E")],
                    message: Message::Approve,
                }),
                Status::Failed { .. } => commands.push(PaletteCommand {
                    label: "Retry".into(),
                    keys: &[KeyPart::Text("E")],
                    message: Message::Retry,
                }),
                _ => {}
            }
            if agent.snooze_until.is_some() {
                commands.push(PaletteCommand {
                    label: "Wake now".into(),
                    keys: &[],
                    message: Message::WakeNow,
                });
            }
            commands.push(PaletteCommand {
                label: "Open in terminal".into(),
                keys: &[],
                message: Message::OpenTerminal,
            });
            commands.push(PaletteCommand {
                label: "Open in editor".into(),
                keys: &[],
                message: Message::OpenEditor,
            });
        }
        commands.push(PaletteCommand {
            label: "Show diff".into(),
            keys: &[KeyPart::Text("D")],
            message: Message::SetTab(Tab::Diff),
        });
        commands.push(PaletteCommand {
            label: "Show transcript".into(),
            keys: &[KeyPart::Text("T")],
            message: Message::SetTab(Tab::Transcript),
        });
        commands
    }

    /// The palette command whose key hint is this single letter.
    fn shortcut(&self, letter: &str) -> Option<Message> {
        self.commands()
            .into_iter()
            .find(|command| matches!(command.keys, [KeyPart::Text(key)] if key.eq_ignore_ascii_case(letter)))
            .map(|command| command.message)
    }

    pub fn palette_matches(&self) -> Vec<PaletteCommand> {
        let Some(Overlay::Palette(palette)) = &self.overlay else {
            return Vec::new();
        };
        let query = palette.query.text.to_lowercase();
        self.commands()
            .into_iter()
            .filter(|command| {
                query
                    .split_whitespace()
                    .all(|word| command.label.to_lowercase().contains(word))
            })
            .collect()
    }

    /// Project IDs matching the composer's project search, best first.
    pub fn project_matches(&self) -> Vec<Id> {
        let Some(Overlay::Composer(Composer {
            project_search: Some(search),
            ..
        })) = &self.overlay
        else {
            return Vec::new();
        };
        let projects = &self.desk.state.projects;
        crate::fuzzy::rank(
            &search.query.text,
            projects.iter().map(|project| project.name.as_str()),
        )
        .into_iter()
        .map(|index| projects[index].id.clone())
        .collect()
    }

    pub fn update(&mut self, message: Message) -> Task {
        let task = self.handle(message);
        // Readback is authoritative. In particular, don't leave a rejected or
        // clamped selection displayed as though Pi accepted it.
        let mut reload = Vec::new();
        for (id, picker) in &mut self.sessions {
            if !picker.loading
                && !self.desk.configuring(id)
                && let Some(agent) = self.desk.state.agent(id)
                && agent.session_settings.model.is_some()
                && picker.settings != agent.session_settings
            {
                if picker.settings.model != agent.session_settings.model {
                    picker.options = None;
                    reload.push(id.clone());
                }
                picker.settings = agent.session_settings.clone();
            }
        }
        let refresh = Task::batch(
            reload
                .into_iter()
                .map(|id| self.load_session(Some(id), None)),
        );
        let task = Task::batch([task, refresh]);
        if self.desk.take_dirty() && self.save_enabled {
            if let Err(error) = self.store.save(&self.desk.state) {
                self.error = Some(format!("Could not save: {error}"));
            }
        }
        let selection = self.ensure_selection();
        let highlight = self.highlight_shown();
        Task::batch([task, selection, highlight])
    }

    fn handle(&mut self, message: Message) -> Task {
        match message {
            Message::Supervisor(event) => self.on_supervisor(event),
            Message::Tick => {
                self.now = now();
                self.last_tick = Instant::now();
                if self
                    .toast
                    .as_ref()
                    .is_some_and(|(_, at)| at.elapsed() > Duration::from_secs(3))
                {
                    self.toast = None;
                }
                let due: Vec<Pending> = self
                    .pending
                    .iter()
                    .filter(|pending| pending.due <= Instant::now())
                    .cloned()
                    .collect();
                self.pending.retain(|pending| pending.due > Instant::now());
                let mut effects = Vec::new();
                for pending in due {
                    effects.extend(match pending.action {
                        Deferred::Merge => self.desk.approve(&pending.id),
                        Deferred::Discard => self.desk.discard(&pending.id),
                        Deferred::MarkDone => self.desk.mark_done(&pending.id),
                    });
                }
                effects.extend(self.desk.schedule(self.now));
                self.run(effects)
            }
            Message::Key { event, captured } => self.on_key(&event, captured).unwrap_or_default(),
            Message::MouseReleased => {
                if let Some((id, Some(target))) = self.dragging.take() {
                    self.desk.place_project(&id, target);
                }
                Task::none()
            }
            Message::Show(view) => {
                self.view = view;
                self.focus = false;
                self.overlay = None;
                let keep = self
                    .current()
                    .is_some_and(|agent| self.in_view(agent, &self.view));
                if keep {
                    return Task::none();
                }
                // Drop the old selection first so its held row isn't listed.
                self.selected = None;
                let first = self.rows().first().map(|agent| agent.id.clone());
                self.select(first)
            }
            Message::Select(id) => self.select(Some(id)),
            Message::Open(id) => {
                let task = self.select(Some(id));
                self.focus = true;
                task
            }
            Message::ToggleFocus => {
                self.focus = !self.focus && self.current().is_some();
                Task::none()
            }
            Message::SetTab(tab) => {
                self.tab = tab;
                match (tab, self.selected.clone()) {
                    (Tab::Diff, Some(id)) => self.load_diff(&id),
                    _ => Task::none(),
                }
            }
            Message::ZoomIn => {
                self.zoom_percent = (self.zoom_percent + 10).min(200);
                Task::none()
            }
            Message::ZoomOut => {
                self.zoom_percent = self.zoom_percent.saturating_sub(10).max(70);
                Task::none()
            }
            Message::ResetZoom => {
                self.zoom_percent = 100;
                Task::none()
            }
            Message::ToggleSidebar => {
                self.show_sidebar = !self.show_sidebar;
                Task::none()
            }
            Message::Choose(index) => {
                match self
                    .current()
                    .and_then(|agent| choices(agent).into_iter().nth(index))
                {
                    Some(choice) => self.handle(choice.message),
                    None => Task::none(),
                }
            }
            Message::Answer(index) => {
                let Some(id) = self.current().map(|agent| agent.id.clone()) else {
                    return Task::none();
                };
                self.act(&id, |desk| desk.answer(&id, index))
            }
            Message::Approve => {
                let Some(agent) = self.current() else {
                    return Task::none();
                };
                let id = agent.id.clone();
                match agent.status {
                    Status::Review => self.defer(Deferred::Merge),
                    _ => self.act(&id, |desk| desk.approve(&id)),
                }
            }
            Message::StartReply => {
                if self.current().is_none() {
                    return Task::none();
                }
                self.replying = true;
                self.reply_vim = crate::vim::Vim::new(self.reply_history.depth());
                self.reply_history.sync(&self.reply);
                self.reply.focused = true;
                if self.desk.state.settings.vim_mode {
                    self.reply_vim.show_block(&mut self.reply);
                }
                Task::none()
            }
            Message::FileDropped(path) => self.insert_path(&path),
            Message::ReplyEdited => {
                self.after_edit(Target::Reply);
                Task::none()
            }
            Message::Vim(target, input) => self.vim_key(target, input),
            Message::VimPut(target, after, count, text) => {
                let Some(text) = text.filter(|text| !text.is_empty()) else {
                    return Task::none();
                };
                if let Some((content, history, vim)) = self.vim_box(target) {
                    vim.clear_block(content);
                    let mut buffer = crate::vim::Buffer::read(content);
                    history.checkpoint(content);
                    vim.put(&mut buffer, &text, after, count);
                    crate::vim::write(content, &buffer, vim.selection(&buffer));
                    history.sync(content);
                }
                Task::none()
            }
            Message::VimHistory(target, undo) => {
                if let Some((content, history, vim)) = self.vim_box(target) {
                    vim.clear_block(content);
                    if undo {
                        history.undo(content);
                    } else {
                        history.redo(content);
                    }
                    let mut buffer = crate::vim::Buffer::read(content);
                    vim.settle(&mut buffer);
                    crate::vim::write(content, &buffer, vim.selection(&buffer));
                    history.sync(content);
                }
                Task::none()
            }
            Message::SendReply => {
                let text = self.reply.text.clone();
                let Some(id) = self.selected.clone() else {
                    return Task::none();
                };
                if text.trim().is_empty() {
                    return Task::none();
                }
                // A reopened main-checkout task diffs from the checkout's
                // current commit, not from its first start.
                let start = match self
                    .current()
                    .map(|agent| (&agent.status, &agent.workspace))
                {
                    Some((Status::Done { .. }, Workspace::Main { checkout, .. })) => {
                        match git::start_point(checkout) {
                            Ok(start) => Some(start),
                            Err(error) => {
                                self.error = Some(error);
                                return Task::none();
                            }
                        }
                    }
                    _ => None,
                };
                self.reply = TextEdit::new("");
                self.reply_history = Default::default();
                self.reply_vim = Default::default();
                self.replying = false;
                self.act(&id, |desk| match start {
                    Some(start) => desk.reopen(&id, &text, Some(start)),
                    None => desk.reply(&id, &text),
                })
            }
            Message::CancelReply => {
                self.replying = false;
                self.reply.focused = false;
                Task::none()
            }
            Message::NewTask => {
                if self.desk.state.projects.is_empty() {
                    return self.handle(Message::AddProject);
                }
                let project = match &self.view {
                    View::Project(id) => Some(id.clone()),
                    _ => self
                        .current()
                        .map(|agent| agent.project_id.clone())
                        .or_else(|| {
                            self.desk
                                .state
                                .projects
                                .first()
                                .map(|project| project.id.clone())
                        }),
                };
                let base = self.base_branch(project.as_deref());
                let content = focused("");
                let mut history = crate::composer_edit::History::default();
                history.sync(&content);
                self.overlay = Some(Overlay::Composer(Composer {
                    history,
                    project,
                    base,
                    use_worktree: false,
                    session: SessionPicker::default(),
                    content,
                    vim: crate::vim::Vim::new(0),
                    error: None,
                    project_search: None,
                    picking_project: false,
                }));
                self.menu = None;
                self.load_session(None, None)
            }
            Message::ComposerProject(id) => {
                let base = self.base_branch(Some(&id));
                if let Some(Overlay::Composer(composer)) = &mut self.overlay {
                    composer.project = Some(id);
                    composer.base = base;
                    composer.session = SessionPicker::default();
                    composer.picking_project = false;
                }
                self.load_session(None, None)
            }
            Message::ComposerProjectMenu => {
                if let Some(Overlay::Composer(composer)) = &mut self.overlay {
                    composer.picking_project = !composer.picking_project;
                }
                Task::none()
            }
            Message::ComposerProjectSearch => {
                let Some(Overlay::Composer(composer)) = &self.overlay else {
                    return Task::none();
                };
                let current = composer.project.clone();
                let selected = self
                    .desk
                    .state
                    .projects
                    .iter()
                    .position(|project| Some(&project.id) == current.as_ref())
                    .unwrap_or(0);
                if let Some(Overlay::Composer(composer)) = &mut self.overlay {
                    composer.content.focused = false;
                    composer.picking_project = false;
                    composer.project_search = Some(ProjectSearch {
                        query: focused(""),
                        selected,
                    });
                }
                Task::none()
            }
            Message::ComposerProjectQuery(query) => {
                if let Some(Overlay::Composer(composer)) = &mut self.overlay
                    && let Some(search) = &mut composer.project_search
                {
                    edit_text(&mut search.query, query);
                    search.selected = 0;
                }
                Task::none()
            }
            Message::ComposerProjectPick(index) => {
                let Some(id) = self.project_matches().into_iter().nth(index) else {
                    return Task::none();
                };
                if let Some(Overlay::Composer(composer)) = &mut self.overlay {
                    composer.project_search = None;
                    composer.content.focused = true;
                }
                self.handle(Message::ComposerProject(id))
            }
            Message::ToggleMenu(menu) => {
                self.menu = if self.menu.as_ref() == Some(&menu) {
                    None
                } else {
                    Some(menu)
                };
                Task::none()
            }
            Message::CloseMenu => {
                self.menu = None;
                Task::none()
            }
            Message::RefreshSession(target) => self.load_session(target, None),
            Message::SessionModel(target, model) => {
                self.menu = None;
                let Some(picker) = self.session_picker(&target) else {
                    return Task::none();
                };
                if picker.loading
                    || !picker
                        .options
                        .as_ref()
                        .is_some_and(|options| options.models.contains(&model))
                {
                    return Task::none();
                }
                let mut settings = picker.settings.clone();
                settings.model = Some(model);
                self.load_session(target, Some(settings))
            }
            Message::SessionEffort(target, effort) => {
                self.menu = None;
                let Some(picker) = self.session_picker(&target) else {
                    return Task::none();
                };
                if picker.loading
                    || !picker
                        .options
                        .as_ref()
                        .is_some_and(|options| options.levels.contains(&effort))
                {
                    return Task::none();
                }
                let mut settings = picker.settings.clone();
                settings.effort = Some(effort);
                if target.as_ref().is_some_and(|id| self.desk.configuring(id)) {
                    return Task::none();
                }
                if let Some(picker) = self.session_picker_mut(&target) {
                    picker.settings = settings.clone();
                }
                match target {
                    Some(id) => {
                        let effects = self.desk.configure(&id, settings);
                        self.run(effects)
                    }
                    None => Task::none(),
                }
            }
            Message::SessionLoaded(target, request, apply, result) => {
                let current = target
                    .as_ref()
                    .and_then(|id| self.desk.state.agent(id))
                    .map(|agent| agent.session_settings.clone());
                let Some(picker) = self
                    .session_picker_mut(&target)
                    .filter(|picker| picker.request == request)
                else {
                    return Task::none();
                };
                picker.loading = false;
                match result {
                    Ok(mut options) => {
                        if !apply
                            && current.as_ref().is_some_and(|settings| {
                                settings.model.is_some()
                                    && picker.requested.as_ref() != Some(settings)
                            })
                        {
                            // The task's state changed while discovery was in
                            // flight. Query its new model instead of showing
                            // levels for the stale one.
                            return self.load_session(target, None);
                        }
                        if apply
                            && picker
                                .requested
                                .as_ref()
                                .and_then(|settings| settings.model.as_ref())
                                .is_some_and(|model| options.settings.model.as_ref() != Some(model))
                        {
                            picker.error = Some("Pi could not select the requested model. Check its availability and authentication.".into());
                            return Task::none();
                        }
                        picker.settings = options.settings.clone();
                        picker.error = None;
                        if !apply
                            && let Some(current) =
                                current.filter(|settings| settings.model.is_some())
                        {
                            if current.model != options.settings.model {
                                // An unavailable saved model must not be silently
                                // replaced. Still offer the available models so
                                // the user can recover without editing state.
                                options.levels.clear();
                                picker.error = Some("This task's model is unavailable. Select an available model or check Pi's authentication.".into());
                            }
                            picker.settings = current;
                        }
                        picker.options = Some(options);
                        if let Some(id) = target
                            && apply
                        {
                            let settings = self.sessions[&id].settings.clone();
                            let effects = self.desk.configure(&id, settings);
                            return self.run(effects);
                        }
                    }
                    Err(error) => picker.error = Some(error),
                }
                Task::none()
            }
            Message::ComposerEdited => {
                if let Some(Overlay::Composer(composer)) = &mut self.overlay {
                    // Working in the editor again ends project search.
                    composer.project_search = None;
                    composer.error = None;
                }
                self.after_edit(Target::Composer);
                Task::none()
            }
            Message::ComposerSubmit => self.submit_composer(),
            Message::ComposerWorktree(on) => {
                if let Some(Overlay::Composer(composer)) = &mut self.overlay {
                    composer.use_worktree = on;
                }
                Task::none()
            }
            Message::CloseOverlay => {
                self.overlay = None;
                self.menu = None;
                Task::none()
            }
            Message::OpenPalette => {
                self.menu = None;
                self.overlay = Some(Overlay::Palette(Palette {
                    query: focused(""),
                    selected: 0,
                }));
                Task::none()
            }
            Message::PaletteQuery(query) => {
                if let Some(Overlay::Palette(palette)) = &mut self.overlay {
                    edit_text(&mut palette.query, query);
                    palette.selected = 0;
                }
                Task::none()
            }
            Message::PaletteRun(index) => {
                let Some(command) = self.palette_matches().into_iter().nth(index) else {
                    return Task::none();
                };
                self.overlay = None;
                self.handle(command.message)
            }
            Message::OpenLater => {
                let Some(agent) = self.current().filter(|agent| !agent.status.is_done()) else {
                    return Task::none();
                };
                self.overlay = Some(Overlay::Later(LaterPicker {
                    agent: agent.id.clone(),
                    custom: TextEdit::new(""),
                    error: None,
                }));
                Task::none()
            }
            Message::LaterPreset(preset) => {
                self.snooze(later::preset(preset, chrono::Local::now()).timestamp())
            }
            Message::LaterCustom(text) => {
                if let Some(Overlay::Later(picker)) = &mut self.overlay {
                    edit_text(&mut picker.custom, text);
                    picker.error = None;
                }
                Task::none()
            }
            Message::LaterSubmit => {
                let Some(Overlay::Later(picker)) = &mut self.overlay else {
                    return Task::none();
                };
                match later::parse(&picker.custom.text, chrono::Local::now()) {
                    Some(until) => self.snooze(until.timestamp()),
                    None => {
                        picker.error = Some(
                            "Use a duration such as 30m, 3h, or 2d, or a time such as 14:30".into(),
                        );
                        Task::none()
                    }
                }
            }
            Message::WakeNow => {
                let Some(id) = self.selected.clone() else {
                    return Task::none();
                };
                self.overlay = None;
                self.desk.snooze(&id, None);
                let effects = self.desk.schedule(now());
                self.run(effects)
            }
            Message::Discard => {
                let Some(agent) = self.current().filter(|agent| !agent.status.is_done()) else {
                    return Task::none();
                };
                self.overlay = Some(Overlay::ConfirmDiscard(agent.id.clone()));
                Task::none()
            }
            Message::ConfirmDiscard => {
                self.overlay = None;
                self.defer(Deferred::Discard)
            }
            Message::MarkDone => self.defer(Deferred::MarkDone),
            Message::Retry => {
                let Some(id) = self.selected.clone() else {
                    return Task::none();
                };
                self.act(&id, |desk| desk.retry(&id))
            }
            Message::Undo => {
                if let Some(pending) = self.pending.pop() {
                    let label = pending.label;
                    let id = pending.id;
                    let task = self.select(Some(id));
                    self.notify(format!("Undone: {label}"));
                    task
                } else if self.desk.undo() {
                    self.notify("Undone");
                    Task::none()
                } else {
                    self.notify("Nothing to undo");
                    Task::none()
                }
            }
            Message::AddProject => Task::ui(Ui::PickFolder),
            Message::ProjectPicked(Some(path)) => match self.desk.add_project(&path) {
                Ok(id) => self.handle(Message::Show(View::Project(id))),
                Err(error) => {
                    self.error = Some(error);
                    Task::none()
                }
            },
            Message::ProjectPicked(None) => Task::none(),
            Message::MoveProject(id, delta) => {
                self.desk.move_project(&id, delta);
                Task::none()
            }
            Message::DragProject(id) => {
                self.dragging = Some((id, None));
                Task::none()
            }
            Message::HoverProject(index) => {
                if let Some((_, target)) = &mut self.dragging {
                    *target = Some(index);
                }
                Task::none()
            }
            Message::OpenTerminal => {
                let template = self.desk.state.settings.terminal_command.clone();
                self.launch(&template);
                Task::none()
            }
            Message::OpenEditor => {
                let template = self.desk.state.settings.editor_command.clone();
                self.launch(&template);
                Task::none()
            }
            Message::DiffLoaded(id, result) => {
                let state = self.diffs.entry(id).or_default();
                state.loading = false;
                match result {
                    Ok(loaded) => {
                        let same = state
                            .files
                            .as_ref()
                            .is_ok_and(|files| Arc::ptr_eq(files, &loaded.files));
                        if !same {
                            // A highlight still running is for the old files.
                            state.highlighting = None;
                        }
                        state.selected = state.selected.min(loaded.files.len().saturating_sub(1));
                        state.files = Ok(loaded.files);
                        state.colors = loaded.colors;
                    }
                    Err(error) => {
                        state.files = Err(error);
                        state.colors.clear();
                        state.highlighting = None;
                    }
                }
                Task::none()
            }
            Message::TranscriptRead(id, transcript) => {
                self.reading_transcripts.remove(&id);
                if let Some(transcript) = transcript {
                    let transcript =
                        Arc::try_unwrap(transcript).unwrap_or_else(|shared| (*shared).clone());
                    self.desk.transcript_read(&id, transcript);
                }
                Task::none()
            }
            Message::DiffHighlighted {
                id,
                files,
                index,
                colors,
            } => {
                if let Some(state) = self.diffs.get_mut(&id)
                    && let Ok(current) = &state.files
                    && Arc::ptr_eq(current, &files)
                {
                    state.colors.insert(index, colors);
                    if state.highlighting == Some(index) {
                        state.highlighting = None;
                    }
                }
                Task::none()
            }
            Message::SelectFile(index) => {
                if let Some(state) = self.selected.as_ref().and_then(|id| self.diffs.get_mut(id)) {
                    state.selected = index;
                }
                Task::none()
            }
            Message::ToggleThinking(agent, message, block) => {
                let key = (agent, message, block);
                if !self.expanded_thinking.remove(&key) {
                    self.expanded_thinking.insert(key);
                }
                Task::none()
            }
            Message::ToggleTool(id) => {
                if !self.expanded.remove(&id) {
                    self.expanded.insert(id);
                }
                Task::none()
            }
            Message::WorktreeCreated(id, result) => {
                let effects = self.desk.on_worktree(&id, result);
                self.run(effects)
            }
            Message::CommitMessageGenerated(id, result) => {
                let effects = self.desk.on_commit_message(&id, result);
                self.run(effects)
            }
            Message::Merged(id, result) => {
                if let Err(error) = &result {
                    self.error = Some(format!("Merge failed: {error}"));
                }
                let effects = self.desk.on_merged(&id, result);
                self.run(effects)
            }
            Message::Removed(id, outcome, result) => {
                if let Err(error) = &result {
                    self.error = Some(format!("Cleanup failed: {error}"));
                }
                let effects = self.desk.on_removed(&id, outcome, result);
                self.diffs.remove(&id);
                self.run(effects)
            }
            Message::Watched(found) => {
                self.watching = false;
                self.watched = found;
                Task::none()
            }
            Message::OpenSettings => {
                let settings = &self.desk.state.settings;
                self.overlay = Some(Overlay::Settings(SettingsForm {
                    slots: TextEdit::new(settings.slots.to_string()),
                    terminal: TextEdit::new(settings.terminal_command.clone()),
                    editor: TextEdit::new(settings.editor_command.clone()),
                    vim_mode: settings.vim_mode,
                    vim_escape: TextEdit::new(settings.vim_escape.clone()),
                    error: None,
                }));
                self.menu = None;
                Task::none()
            }
            Message::SettingsSlots(value) => {
                self.edit_settings(|form| edit_text(&mut form.slots, value))
            }
            Message::SettingsTerminal(value) => {
                self.edit_settings(|form| edit_text(&mut form.terminal, value))
            }
            Message::SettingsEditor(value) => {
                self.edit_settings(|form| edit_text(&mut form.editor, value))
            }
            Message::SettingsVim(on) => self.edit_settings(|form| form.vim_mode = on),
            Message::SettingsVimEscape(value) => {
                self.edit_settings(|form| edit_text(&mut form.vim_escape, value))
            }
            Message::SaveSettings => {
                let Some(Overlay::Settings(form)) = &mut self.overlay else {
                    return Task::none();
                };
                let Some(slots) = form
                    .slots
                    .text
                    .trim()
                    .parse::<usize>()
                    .ok()
                    .filter(|slots| (1..=64).contains(slots))
                else {
                    form.error = Some("Running agents must be a number from 1 to 64".into());
                    return Task::none();
                };
                let vim_escape = form.vim_escape.text.trim().to_string();
                if vim_escape.chars().count() > 4 || vim_escape.chars().any(char::is_whitespace) {
                    form.error =
                        Some("The escape sequence must be up to 4 keys with no spaces".into());
                    return Task::none();
                }
                let settings = Settings {
                    slots,
                    terminal_command: form.terminal.text.trim().to_string(),
                    editor_command: form.editor.text.trim().to_string(),
                    vim_mode: form.vim_mode,
                    vim_escape,
                };
                self.overlay = None;
                self.desk.set_settings(settings);
                let effects = self.desk.schedule(now());
                self.run(effects)
            }
            Message::DismissError => {
                self.error = None;
                Task::none()
            }
            Message::Link(url) => {
                let _ = std::process::Command::new("open").arg(url).spawn();
                Task::none()
            }
        }
    }

    fn base_branch(&self, project: Option<&str>) -> Result<String, String> {
        let project = project
            .and_then(|id| self.desk.state.project(id))
            .ok_or("Choose a project")?;
        git::current_branch(&project.path)
    }

    fn edit_settings(&mut self, change: impl FnOnce(&mut SettingsForm)) -> Task {
        if let Some(Overlay::Settings(form)) = &mut self.overlay {
            change(form);
            form.error = None;
        }
        Task::none()
    }

    /// The box, its vim undo history, and its vim state for `target`.
    fn vim_box(
        &mut self,
        target: Target,
    ) -> Option<(
        &mut TextEdit,
        &mut crate::composer_edit::History,
        &mut crate::vim::Vim,
    )> {
        match target {
            Target::Reply => Some((
                &mut self.reply,
                &mut self.reply_history,
                &mut self.reply_vim,
            )),
            Target::Composer => match &mut self.overlay {
                Some(Overlay::Composer(composer)) => Some((
                    &mut composer.content,
                    &mut composer.history,
                    &mut composer.vim,
                )),
                _ => None,
            },
        }
    }

    /// Keeps vim state in step after the field changed its own text.
    fn after_edit(&mut self, target: Target) {
        let vim_mode = self.desk.state.settings.vim_mode;
        if let Some((content, history, vim)) = self.vim_box(target) {
            history.observe(content);
            vim.interrupt();
            if vim_mode {
                vim.show_block(content);
            }
        }
    }

    fn vim_key(&mut self, target: Target, input: crate::vim::Input) -> Task {
        use crate::vim::{Buffer, Input, Mode};
        let sequence = self.desk.state.settings.vim_escape.clone();
        let Some((content, history, vim)) = self.vim_box(target) else {
            return Task::none();
        };
        vim.clear_block(content);
        // Changes the field made since the last key, such as a paste.
        history.observe(content);
        let before = content.text.clone();
        let mut buffer = Buffer::read(content);
        let outcome = match (vim.mode, input) {
            (Mode::Insert, Input::Char(c)) => {
                vim.insert_char(&sequence, &mut buffer, c, std::time::Instant::now())
            }
            (_, input) => vim.handle(&mut buffer, input),
        };
        if let Some(c) = outcome.insert {
            history.insert(content, &c.to_string());
            return Task::none();
        }
        if outcome.entered_insert {
            vim.insert_mark = Some(history.depth());
        }
        if buffer.text() != before && !outcome.silent {
            history.checkpoint(content);
        }
        let mut task = Task::none();
        if outcome.undo > 0 || outcome.redo > 0 {
            for _ in 0..outcome.undo.max(outcome.redo) {
                if outcome.undo > 0 {
                    history.undo(content);
                } else {
                    history.redo(content);
                }
            }
            buffer = Buffer::read(content);
            vim.settle(&mut buffer);
        }
        let selection = vim.selection(&buffer);
        crate::vim::write(content, &buffer, selection);
        history.sync(content);
        if outcome.left_insert
            && let Some(mark) = vim.insert_mark.take()
        {
            history.collapse(mark, content);
        }
        if let Some(yank) = outcome.yank {
            task = Task::ui(Ui::Copy(yank));
        }
        if let Some((after, count)) = outcome.put {
            task = Task::ui(Ui::Paste(Box::new(move |text| {
                Message::VimPut(target, after, count, text)
            })));
        }
        task
    }

    /// Types a dropped file's path at the cursor of the open task composer or
    /// reply. With neither open, it starts a reply to the selected task.
    fn insert_path(&mut self, path: &std::path::Path) -> Task {
        let text = format!("{} ", quote_path(path));
        let target = match &self.overlay {
            Some(Overlay::Composer(_)) => Target::Composer,
            Some(_) => return Task::none(),
            None => {
                if !self.replying {
                    if self.current().is_none() {
                        return Task::none();
                    }
                    self.replying = true;
                    self.reply_history.sync(&self.reply);
                }
                Target::Reply
            }
        };
        if let Some((content, history, vim)) = self.vim_box(target) {
            vim.clear_block(content);
            history.insert(content, &text);
            content.focused = true;
        }
        self.after_edit(target);
        Task::none()
    }

    fn snooze(&mut self, until: Timestamp) -> Task {
        let Some(Overlay::Later(picker)) = self.overlay.take() else {
            return Task::none();
        };
        self.desk.snooze(&picker.agent, Some(until));
        self.notify(format!("Later: {}", later::clock(until)));
        Task::none()
    }

    /// A task's model picker, or the open composer's when `target` is `None`.
    pub fn session_picker(&self, target: &Option<Id>) -> Option<&SessionPicker> {
        match target {
            Some(id) => self.sessions.get(id),
            None => match &self.overlay {
                Some(Overlay::Composer(composer)) => Some(&composer.session),
                _ => None,
            },
        }
    }

    fn session_picker_mut(&mut self, target: &Option<Id>) -> Option<&mut SessionPicker> {
        match target {
            Some(id) => self.sessions.get_mut(id),
            None => match &mut self.overlay {
                Some(Overlay::Composer(composer)) => Some(&mut composer.session),
                _ => None,
            },
        }
    }

    fn load_session(
        &mut self,
        target: Option<Id>,
        change: Option<SessionSettings>,
    ) -> Task {
        let (cwd, settings) = match &target {
            Some(id) => {
                let Some(agent) = self.desk.state.agent(id) else {
                    return Task::none();
                };
                if agent.status.is_done() || self.desk.configuring(id) {
                    return Task::none();
                }
                let Some(cwd) = self.desk.work_dir(agent) else {
                    return Task::none();
                };
                (cwd, agent.session_settings.clone())
            }
            None => {
                let Some(Overlay::Composer(composer)) = &self.overlay else {
                    return Task::none();
                };
                let Some(project) = composer
                    .project
                    .as_ref()
                    .and_then(|id| self.desk.state.project(id))
                else {
                    return Task::none();
                };
                (project.path.clone(), composer.session.settings.clone())
            }
        };
        self.next_session_request += 1;
        let request = self.next_session_request;
        if let Some(id) = &target {
            self.sessions.entry(id.clone()).or_default();
        }
        let Some(picker) = self.session_picker_mut(&target) else {
            return Task::none();
        };
        if change.is_none() {
            picker.settings = settings.clone();
        }
        picker.requested = Some(change.clone().unwrap_or_else(|| settings.clone()));
        picker.request = request;
        picker.loading = true;
        picker.error = None;
        let apply = change.is_some();
        let program = self.desk.pi_program().to_string();
        Task::perform(
            crate::models::discover(program, cwd, change.unwrap_or(settings)),
            move |result| Message::SessionLoaded(target.clone(), request, apply, result),
        )
    }

    fn submit_composer(&mut self) -> Task {
        let Some(Overlay::Composer(composer)) = &mut self.overlay else {
            return Task::none();
        };
        if composer.session.loading {
            return Task::none();
        }
        let Some(draft) = compose::draft(&composer.content.text) else {
            composer.error = Some("Describe the work first".into());
            return Task::none();
        };
        let Some(project) = composer
            .project
            .clone()
            .and_then(|id| self.desk.state.project(&id).cloned())
        else {
            composer.error = Some("Choose a project".into());
            return Task::none();
        };
        // Read the branch again: it may have changed since the sheet opened.
        let base = match git::current_branch(&project.path) {
            Ok(base) => base,
            Err(error) => {
                composer.error = Some(error);
                return Task::none();
            }
        };
        let isolation = if composer.use_worktree {
            match git::is_unborn(&project.path) {
                Ok(false) => Isolation::Worktree,
                Ok(true) => {
                    composer.error = Some(format!(
                        "{} has no commits yet; make a first commit or uncheck Use worktree",
                        project.path.display()
                    ));
                    return Task::none();
                }
                Err(error) => {
                    composer.error = Some(error);
                    return Task::none();
                }
            }
        } else {
            match git::start_point(&project.path) {
                Ok(start) => Isolation::Main { start },
                Err(error) => {
                    composer.error = Some(error);
                    return Task::none();
                }
            }
        };
        let settings = composer.session.settings.clone();
        self.overlay = None;
        self.menu = None;
        let effects = self
            .desk
            .file(&project.id, &base, isolation, settings, vec![draft]);
        self.notify("Filed the task");
        Task::batch([self.run(effects), self.watch()])
    }

    fn on_supervisor(&mut self, event: supervisor::Event) -> Task {
        match event {
            supervisor::Event::Ready(handle) => {
                for request in self.backlog.drain(..) {
                    handle.send(request);
                }
                self.supervisor = Some(handle);
                let effects = self.desk.schedule(now());
                let models = self
                    .selected
                    .clone()
                    .map(|id| self.load_session(Some(id), None))
                    .unwrap_or_else(Task::none);
                Task::batch([self.run(effects), models])
            }
            supervisor::Event::Lines {
                agent,
                generation,
                lines,
            } => {
                let before = self
                    .desk
                    .state
                    .agent(&agent)
                    .map(|agent| agent.status.clone());
                let effects = self.desk.on_lines(&agent, generation, &lines);
                let after = self
                    .desk
                    .state
                    .agent(&agent)
                    .map(|agent| agent.status.clone());
                let refresh = before != after && self.selected.as_deref() == Some(agent.as_str());
                let run = self.run(effects);
                if refresh {
                    Task::batch([run, self.load_diff(&agent)])
                } else {
                    run
                }
            }
            supervisor::Event::Exited {
                agent,
                generation,
                code,
                stderr,
            } => {
                let effects = self.desk.on_exit(&agent, generation, code, &stderr);
                self.run(effects)
            }
            supervisor::Event::SpawnFailed {
                agent,
                generation,
                error,
            } => {
                let effects = self.desk.on_spawn_failed(&agent, generation, error);
                self.run(effects)
            }
        }
    }

    /// Window keys. `captured` means a focused field saw the key first and
    /// passed it on. Returns `None` for keys the app leaves alone.
    pub fn on_key(&mut self, event: &KeyEvent, captured: bool) -> Option<Task> {
        let mods = event.mods;
        let command = command_char(event);
        // Zoom is window-wide, even when a box or overlay owns normal keys.
        if !mods.alt {
            let zoom = match command {
                Some('=' | '+') => Some(Message::ZoomIn),
                Some('-') => Some(Message::ZoomOut),
                Some('0') => Some(Message::ResetZoom),
                _ => None,
            };
            if let Some(message) = zoom {
                return Some(self.handle(message));
            }
        }
        if self.menu.is_some() && event.key == Key::Escape {
            self.menu = None;
            return Some(Task::none());
        }
        // Overlays first: Escape closes them, and they own arrows and Enter.
        if self.overlay.is_some() {
            if event.key == Key::Escape {
                return Some(self.escape_overlay());
            }
            let count = self.palette_matches().len();
            let project_count = self.project_matches().len();
            let plain = !mods.cmd && !mods.alt && !mods.ctrl;
            match &mut self.overlay {
                Some(Overlay::Palette(palette)) => match event.key {
                    Key::Down => {
                        palette.selected = (palette.selected + 1).min(count.saturating_sub(1))
                    }
                    Key::Up => palette.selected = palette.selected.saturating_sub(1),
                    Key::Enter => {
                        let index = palette.selected;
                        return Some(self.handle(Message::PaletteRun(index)));
                    }
                    _ => return None,
                },
                Some(Overlay::Later(_)) if !captured => {
                    if let Some(preset) = typed(event)
                        .and_then(|c| c.parse::<usize>().ok())
                        .and_then(|n| later::Preset::ALL.get(n.wrapping_sub(1)))
                    {
                        return Some(self.handle(Message::LaterPreset(*preset)));
                    }
                    return None;
                }
                Some(Overlay::Composer(Composer {
                    project_search: Some(search),
                    ..
                })) if plain => match event.key {
                    Key::Down => {
                        search.selected = (search.selected + 1).min(project_count.saturating_sub(1))
                    }
                    Key::Up => search.selected = search.selected.saturating_sub(1),
                    Key::Enter => {
                        let index = search.selected;
                        return Some(self.handle(Message::ComposerProjectPick(index)));
                    }
                    _ => return None,
                },
                // The box binds the same keys while it has focus.
                Some(Overlay::Composer(composer)) if !mods.shift && !mods.alt => {
                    match command {
                        Some('e') => composer.use_worktree = !composer.use_worktree,
                        Some('p') => return Some(self.handle(Message::ComposerProjectSearch)),
                        _ if event.key == Key::Enter && mods.cmd => {
                            return Some(self.handle(Message::ComposerSubmit));
                        }
                        _ => return None,
                    }
                }
                Some(Overlay::ConfirmDiscard(_)) if !captured => {
                    if event.key == Key::Enter || typed(event) == Some("x") {
                        return Some(self.handle(Message::ConfirmDiscard));
                    }
                    return None;
                }
                _ => return None,
            }
            return Some(Task::none());
        }
        if command == Some('k') {
            return Some(self.handle(Message::OpenPalette));
        }
        if captured {
            return None;
        }
        if mods.alt
            && !mods.cmd
            && let View::Project(id) = &self.view
        {
            let id = id.clone();
            match event.key {
                Key::Up => return Some(self.handle(Message::MoveProject(id, -1))),
                Key::Down => return Some(self.handle(Message::MoveProject(id, 1))),
                _ => {}
            }
        }
        if mods.cmd || mods.ctrl || mods.alt || mods.logo {
            return None;
        }
        match &event.key {
            Key::Down => Some(self.move_selection(1)),
            Key::Up => Some(self.move_selection(-1)),
            Key::Enter => Some(match self.selected.clone() {
                Some(id) => self.handle(Message::Open(id)),
                None => Task::none(),
            }),
            Key::Escape => {
                if self.replying {
                    self.replying = false;
                } else if self.focus {
                    self.focus = false;
                } else {
                    return None;
                }
                Some(Task::none())
            }
            Key::Text(c) => match c.to_lowercase().as_str() {
                "j" => Some(self.move_selection(1)),
                "k" => Some(self.move_selection(-1)),
                letter => {
                    if let Some(message) = self.shortcut(letter) {
                        return Some(self.handle(message));
                    }
                    match letter.parse::<usize>() {
                        Ok(n) if (1..=9).contains(&n) => Some(self.handle(Message::Choose(n - 1))),
                        _ => None,
                    }
                }
            },
            _ => None,
        }
    }

    /// Escape in an overlay: leaves project search first, then closes it.
    fn escape_overlay(&mut self) -> Task {
        if self.menu.take().is_some() {
            return Task::none();
        }
        if let Some(Overlay::Composer(composer)) = &mut self.overlay {
            if composer.picking_project {
                composer.picking_project = false;
                return Task::none();
            }
            if composer.project_search.take().is_some() {
                composer.content.focused = true;
                return Task::none();
            }
        }
        self.overlay = None;
        Task::none()
    }

    /// A key in the reply box or the task composer, before the field edits.
    /// Returns true when the app took it.
    pub fn box_key(&mut self, target: Target, event: &KeyEvent) -> Option<Task> {
        let vim_mode = self.desk.state.settings.vim_mode;
        if vim_mode {
            let sequence = self.desk.state.settings.vim_escape.clone();
            let route = match target {
                Target::Reply => crate::vim::route(event, target, &self.reply_vim, &sequence),
                Target::Composer => match &self.overlay {
                    Some(Overlay::Composer(composer)) => {
                        crate::vim::route(event, target, &composer.vim, &sequence)
                    }
                    _ => return None,
                },
            };
            match route {
                crate::vim::Route::Vim(input) => {
                    return Some(self.update(Message::Vim(target, input)));
                }
                crate::vim::Route::Ignore => return Some(Task::none()),
                crate::vim::Route::Usual => {}
            }
            let mods = event.mods;
            if command_char(event) == Some('z') && !mods.alt {
                return Some(self.update(Message::VimHistory(target, !mods.shift)));
            }
        }
        let mods = event.mods;
        match target {
            Target::Reply => match event.key {
                Key::Enter if !mods.shift && !mods.alt && !mods.cmd => {
                    Some(self.update(Message::SendReply))
                }
                Key::Escape => Some(self.update(Message::CancelReply)),
                _ => None,
            },
            Target::Composer => {
                if event.key == Key::Escape {
                    return Some(self.update(Message::CloseOverlay));
                }
                if event.key == Key::Enter && mods.cmd {
                    return Some(self.update(Message::ComposerSubmit));
                }
                if mods.shift || mods.alt {
                    return None;
                }
                match command_char(event) {
                    Some('e') => {
                        let on = matches!(&self.overlay, Some(Overlay::Composer(c)) if !c.use_worktree);
                        Some(self.update(Message::ComposerWorktree(on)))
                    }
                    Some('p') => Some(self.update(Message::ComposerProjectSearch)),
                    _ => None,
                }
            }
        }
    }

    /// Starts `task`: futures run on tokio and report back through the
    /// inbox; window requests wait for a `Tx`.
    pub fn start(&mut self, task: Task) {
        for future in task.futures {
            self.inbox.spawn(future);
        }
        self.ui.extend(task.ui);
    }

    /// Updates and starts the resulting work.
    pub fn send(&mut self, message: Message) {
        let task = self.update(message);
        self.start(task);
    }

    /// [`App::send`] from a handler, applying window requests at once.
    pub fn dispatch(&mut self, message: Message, tx: &mut Tx) {
        self.send(message);
        self.flush(tx);
    }

    /// Applies queued window requests.
    pub fn flush(&mut self, tx: &mut Tx) {
        for request in std::mem::take(&mut self.ui) {
            match request {
                Ui::Reveal(key) => tx.scroll_into_view(key),
                Ui::Copy(text) => tx.copy(text),
                Ui::Paste(make) => tx.read_clipboard(move |s: &mut App, content, tx| {
                    let text = Some(content.text().to_string());
                    s.dispatch(make(text), tx);
                }),
                Ui::PickFolder => tx.open_folder(
                    rune::FileDialogOptions {
                        title: "Choose a git repository".into(),
                        ..Default::default()
                    },
                    |s: &mut App, result, tx| {
                        let path = result.ok().flatten();
                        s.dispatch(Message::ProjectPicked(path), tx);
                    },
                ),
            }
        }
    }

    /// Runs before every frame: delivers background messages and timers.
    /// Returns whether state changed.
    pub fn poll(&mut self, tx: &mut Tx) -> bool {
        let mut changed = false;
        while let Some(message) = self.inbox.try_recv() {
            self.send(message);
            changed = true;
        }
        let fast = !self.pending.is_empty() || self.toast.is_some();
        let every = if fast {
            Duration::from_millis(250)
        } else {
            Duration::from_secs(15)
        };
        if self.last_tick.elapsed() >= every {
            self.send(Message::Tick);
            changed = true;
        }
        let watch_due = self
            .last_watch
            .is_none_or(|at| at.elapsed() >= WATCH_EVERY);
        if watch_due && !self.desk.state.agents.is_empty() {
            let task = self.watch();
            self.start(task);
        }
        tx.wake_after(every.saturating_sub(self.last_tick.elapsed()));
        if !self.desk.state.agents.is_empty() {
            let since = self.last_watch.map_or(Duration::ZERO, |at| at.elapsed());
            tx.wake_after(WATCH_EVERY.saturating_sub(since).max(Duration::from_millis(50)));
        }
        if !self.ui.is_empty() {
            self.flush(tx);
            changed = true;
        }
        changed
    }

    /// The field an accessor edits, or a scratch field when its box closed.
    pub fn field(&mut self, field: Field) -> &mut TextEdit {
        let edit = match (field, &mut self.overlay) {
            (Field::Reply, _) => Some(&mut self.reply),
            (Field::Composer, Some(Overlay::Composer(composer))) => Some(&mut composer.content),
            (Field::ProjectSearch, Some(Overlay::Composer(composer))) => composer
                .project_search
                .as_mut()
                .map(|search| &mut search.query),
            (Field::Palette, Some(Overlay::Palette(palette))) => Some(&mut palette.query),
            (Field::Later, Some(Overlay::Later(picker))) => Some(&mut picker.custom),
            (Field::Slots, Some(Overlay::Settings(form))) => Some(&mut form.slots),
            (Field::Terminal, Some(Overlay::Settings(form))) => Some(&mut form.terminal),
            (Field::Editor, Some(Overlay::Settings(form))) => Some(&mut form.editor),
            (Field::VimEscape, Some(Overlay::Settings(form))) => Some(&mut form.vim_escape),
            _ => None,
        };
        match edit {
            Some(edit) => edit,
            None => &mut self.scratch,
        }
    }
}

/// Text fields, for accessors that outlive their box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Reply,
    Composer,
    ProjectSearch,
    Palette,
    Later,
    Slots,
    Terminal,
    Editor,
    VimEscape,
}

/// Reads goals and swarm workers for `items`.
pub fn read_watched(
    swarm_dir: &std::path::Path,
    items: &[WatchItem],
    followers: &Mutex<HashMap<Id, goal::Follower>>,
) -> HashMap<Id, Watched> {
    let sessions: HashSet<String> = items.iter().map(|item| item.session.clone()).collect();
    let mut workers = swarm::scan(swarm_dir, &sessions);
    let mut followers = followers.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    followers.retain(|id, _| items.iter().any(|item| &item.id == id));
    let mut found = HashMap::new();
    for item in items {
        let goal = item.file.as_ref().and_then(|file| {
            let follower = followers.entry(item.id.clone()).or_default();
            follower.read(file).ok()?;
            follower.goal().cloned()
        });
        let workers = workers.remove(&item.session).unwrap_or_default();
        if goal.is_some() || !workers.is_empty() {
            found.insert(item.id.clone(), Watched { goal, workers });
        }
    }
    found
}

/// A path as text an agent can read back unambiguously. Paths with spaces,
/// like macOS screenshot names, are single-quoted in shell style.
fn quote_path(path: &std::path::Path) -> String {
    let path = path.to_string_lossy();
    if path
        .chars()
        .any(|c| c.is_whitespace() || c == '\'' || c == '"')
    {
        shell_quote(&path)
    } else {
        path.into_owned()
    }
}

/// The window's `setup` hook: starts the supervisor.
pub fn window_setup(app: &mut App, waker: rune::Waker) {
    app.inbox.set_waker(waker);
    // The supervisor owns Pi processes; its events arrive like any message.
    let outbox = app.inbox.outbox();
    crate::task::handle().spawn(async move {
        use futures::StreamExt;
        let mut events = std::pin::pin!(supervisor::run());
        while let Some(event) = events.next().await {
            outbox.send(Message::Supervisor(event));
        }
    });
}

/// The window's `poll` hook.
pub fn window_poll(app: &mut App, _clock: f64, tx: &mut Tx) -> bool {
    app.poll(tx)
}

/// The window's `on_key` hook.
pub fn window_key(app: &mut App, event: &KeyEvent, tx: &mut Tx) -> bool {
    let captured = tx.focused().is_some();
    match app.on_key(event, captured) {
        Some(task) => {
            app.start(task);
            app.flush(tx);
            true
        }
        None => false,
    }
}

/// The window: size, hooks, and the view.
pub fn spec() -> rune::AppSpec<App> {
    let mut spec = rune::AppSpec::new("pi-desk", (1440.0, 900.0), App::boot, crate::views::root);
    spec.min_size = Some((760.0, 520.0));
    // Mono spans, such as inline code in Markdown, use the platform
    // monospace (SF Mono on macOS), as code blocks and paths do.
    spec.families = ("Inter", "ui-monospace");
    spec.setup = Some(window_setup);
    spec.poll = Some(window_poll);
    spec.on_key = Some(window_key);
    spec
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: &str = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-fn a() {}\n+fn a() { 1 }\n";
    const TWO: &str = "diff --git a/b.rs b/b.rs\n--- a/b.rs\n+++ b/b.rs\n@@ -1 +1 @@\n-fn b() {}\n+fn b() { 2 }\n";

    fn colored(loaded: &LoadedDiff, index: usize) -> HashMap<usize, FileColors> {
        let file = &loaded.files[index];
        HashMap::from([(
            index,
            Arc::new(crate::highlight::diff_lines(&file.path, &file.lines)),
        )])
    }

    #[test]
    fn an_unchanged_diff_keeps_its_files_and_colors() {
        let first = LoadedDiff::parse(ONE, None);
        assert!(
            first.colors.is_empty(),
            "nothing is highlighted while parsing"
        );
        let colors = colored(&first, 0);
        let again = LoadedDiff::parse(ONE, Some((first.files.clone(), colors.clone())));
        assert!(Arc::ptr_eq(&again.files, &first.files));
        assert!(Arc::ptr_eq(&again.colors[&0], &colors[&0]));
    }

    #[test]
    fn a_changed_diff_keeps_colors_only_for_unchanged_files() {
        let first = LoadedDiff::parse(ONE, None);
        let colors = colored(&first, 0);
        // a.rs moves to index 1 and is unchanged; b.rs is new.
        let both = format!("{TWO}{ONE}");
        let next = LoadedDiff::parse(&both, Some((first.files.clone(), colors.clone())));
        assert_eq!(next.files.len(), 2);
        assert!(Arc::ptr_eq(&next.colors[&1], &colors[&0]));
        assert!(!next.colors.contains_key(&0));
        let changed = ONE.replace("{ 1 }", "{ 3 }");
        let edited = LoadedDiff::parse(&changed, Some((first.files.clone(), colors)));
        assert!(
            edited.colors.is_empty(),
            "an edited file is highlighted again"
        );
    }
}
