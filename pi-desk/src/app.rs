//! The iced application: window state, messages, and the update loop. Agent
//! logic lives in [`Desk`]; this module turns its effects into processes and
//! git jobs, and turns input into desk actions.

use crate::compose;
use crate::desk::{Desk, Effect};
use crate::git::{self, FileDiff, Merge};
use crate::later;
use crate::model::*;
use crate::order;
use crate::store::Store;
use crate::supervisor::{self, Request};
use iced::keyboard::{self, Key, Modifiers, key::Named};
use iced::widget::{operation, text_editor};
use iced::{Element, Subscription, Task, event, time};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const UNDO_WINDOW: Duration = Duration::from_secs(5);
pub const REPLY_ID: &str = "reply";
pub const PALETTE_ID: &str = "palette";
pub const LATER_ID: &str = "later";
pub const COMPOSER_ID: &str = "composer";

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
    pub project: Option<Id>,
    /// The branch new tasks merge into: the project's current branch.
    pub base: Result<String, String>,
    pub priority: Priority,
    pub content: text_editor::Content,
    pub error: Option<String>,
}

pub struct Palette {
    pub query: String,
    pub selected: usize,
}

pub struct LaterPicker {
    pub agent: Id,
    pub custom: String,
    pub error: Option<String>,
}

pub struct SettingsForm {
    pub slots: String,
    pub terminal: String,
    pub editor: String,
    pub error: Option<String>,
}

pub enum Overlay {
    Composer(Composer),
    Palette(Palette),
    Later(LaterPicker),
    Settings(SettingsForm),
    ConfirmDiscard(Id),
}

pub struct DiffState {
    pub files: Result<Vec<FileDiff>, String>,
    pub colors: Vec<Vec<crate::highlight::Spans>>,
    pub selected: usize,
    pub loading: bool,
}

#[derive(Debug, Clone)]
pub enum Message {
    Supervisor(supervisor::Event),
    Tick,
    Key {
        key: Key,
        modifiers: Modifiers,
        captured: bool,
    },
    MouseReleased,
    Show(View),
    Select(Id),
    Open(Id),
    ToggleBoard,
    ToggleFocus,
    SetTab(Tab),
    ToggleSidebar,
    ZoomIn,
    ZoomOut,
    ResetZoom,
    Choose(usize),
    Approve,
    StartReply,
    ReplyEdit(text_editor::Action),
    SendReply,
    CancelReply,
    NewTask,
    ComposerProject(Id),
    ComposerPriority(Priority),
    ComposerEdit(text_editor::Action),
    ComposerSubmit,
    CloseOverlay,
    OpenPalette,
    PaletteQuery(String),
    PaletteRun(usize),
    OpenLater,
    LaterPreset(later::Preset),
    LaterCustom(String),
    LaterSubmit,
    WakeNow,
    SetPriority(Priority),
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
    DiffLoaded(Id, Result<String, String>),
    SelectFile(usize),
    ToggleTool(String),
    WorktreeCreated(Id, Result<(), String>),
    Merged(Id, Result<Merge, String>),
    Removed(Id, Outcome, Result<(), String>),
    OpenSettings,
    SettingsSlots(String),
    SettingsTerminal(String),
    SettingsEditor(String),
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
    pub board: bool,
    pub focus: bool,
    pub selected: Option<Id>,
    pub tab: Tab,
    pub show_sidebar: bool,
    // Window-only preference. Never written to saved state.
    zoom_percent: u16,
    pub replying: bool,
    pub reply: text_editor::Content,
    pub overlay: Option<Overlay>,
    pub pending: Vec<Pending>,
    pub diffs: HashMap<Id, DiffState>,
    pub expanded: HashSet<String>,
    pub toast: Option<(String, Instant)>,
    pub error: Option<String>,
    pub dragging: Option<(Id, Option<usize>)>,
    pub now: Timestamp,
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
    pub keys: &'static str,
    pub message: Message,
}

impl App {
    pub fn boot() -> (App, Task<Message>) {
        let pi = std::env::var("PI_DESK_PI").unwrap_or_else(|_| "pi".into());
        (App::new(Store::default_location(), pi), Task::none())
    }

    /// Loads saved state from `store`. Agents start once the supervisor
    /// subscription reports ready.
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
            view: View::Inbox,
            board: false,
            focus: false,
            selected: None,
            tab: Tab::Transcript,
            show_sidebar: true,
            zoom_percent: 100,
            replying: false,
            reply: text_editor::Content::new(),
            overlay: None,
            pending: Vec::new(),
            diffs: HashMap::new(),
            expanded: HashSet::new(),
            toast: None,
            error,
            dragging: None,
            now: now(),
        };
        let _ = app.ensure_selection();
        app
    }

    /// Additional UI scale, multiplied by the display scale by iced.
    pub fn scale_factor(&self) -> f32 {
        f32::from(self.zoom_percent) / 100.0
    }

    pub fn title(&self) -> String {
        "pi-desk".into()
    }

    pub fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![
            Subscription::run(supervisor::run).map(Message::Supervisor),
            event::listen_with(|event, status, _| match event {
                iced::Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) => {
                    Some(Message::Key {
                        key,
                        modifiers,
                        captured: status == event::Status::Captured,
                    })
                }
                iced::Event::Mouse(iced::mouse::Event::ButtonReleased(
                    iced::mouse::Button::Left,
                )) => Some(Message::MouseReleased),
                _ => None,
            }),
        ];
        let fast = !self.pending.is_empty() || self.toast.is_some();
        subscriptions.push(
            time::every(if fast {
                Duration::from_millis(250)
            } else {
                Duration::from_secs(15)
            })
            .map(|_| Message::Tick),
        );
        Subscription::batch(subscriptions)
    }

    // Rows and selection

    /// Rows of the current view, in display order.
    pub fn rows(&self) -> Vec<&Agent> {
        let state = &self.desk.state;
        let hidden = |agent: &Agent| self.pending.iter().any(|pending| pending.id == agent.id);
        let mut rows: Vec<&Agent> = state
            .agents
            .iter()
            .filter(|agent| {
                !hidden(agent)
                    && match &self.view {
                        View::All => true,
                        View::Inbox => agent.in_inbox(self.now),
                        View::Working => {
                            matches!(agent.status, Status::Working | Status::Queued)
                                && !agent.snoozed(self.now)
                        }
                        View::Later => agent.snoozed(self.now) && !agent.status.is_done(),
                        View::Done => agent.status.is_done(),
                        View::Project(id) => &agent.project_id == id && !agent.status.is_done(),
                    }
            })
            .collect();
        rows.sort_by(|a, b| order::compare_display(a, b, self.now));
        rows
    }

    pub fn inbox_count(&self) -> usize {
        order::inbox(&self.desk.state, self.now)
            .iter()
            .filter(|agent| !self.pending.iter().any(|pending| pending.id == agent.id))
            .count()
    }

    pub fn current(&self) -> Option<&Agent> {
        let id = self.selected.as_ref()?;
        if self.pending.iter().any(|pending| &pending.id == id) {
            return None;
        }
        self.desk.state.agent(id)
    }

    fn ensure_selection(&mut self) -> Task<Message> {
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

    fn select(&mut self, id: Option<Id>) -> Task<Message> {
        if self.selected == id {
            return Task::none();
        }
        self.selected = id.clone();
        self.replying = false;
        let Some(id) = id else { return Task::none() };
        self.desk.load_transcript(&id);
        self.load_diff(&id)
    }

    /// After acting on a row, show the row that took its place.
    fn advance_from(&mut self, id: &str, before: &[Id]) -> Task<Message> {
        if self.selected.as_deref() != Some(id) {
            return Task::none();
        }
        let rows: Vec<Id> = self.rows().iter().map(|agent| agent.id.clone()).collect();
        let index = before.iter().position(|row| row == id).unwrap_or(0);
        let next = before[index + 1..]
            .iter()
            .chain(before[..index].iter().rev())
            .find(|row| rows.contains(row))
            .cloned();
        let next = next.or_else(|| rows.first().cloned());
        self.select(next)
    }

    fn row_ids(&self) -> Vec<Id> {
        self.rows().iter().map(|agent| agent.id.clone()).collect()
    }

    fn move_selection(&mut self, delta: isize) -> Task<Message> {
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

    // Effects

    fn supervise(&mut self, request: Request) {
        match &self.supervisor {
            Some(handle) => handle.send(request),
            None => self.backlog.push(request),
        }
    }

    fn run(&mut self, effects: Vec<Effect>) -> Task<Message> {
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

    fn load_diff(&mut self, id: &str) -> Task<Message> {
        let Some(agent) = self.desk.state.agent(id) else {
            return Task::none();
        };
        if !agent.worktree.exists() {
            return Task::none();
        }
        let (worktree, base) = (agent.worktree.clone(), agent.base_branch.clone());
        let entry = self.diffs.entry(id.to_string()).or_insert(DiffState {
            files: Ok(Vec::new()),
            colors: Vec::new(),
            selected: 0,
            loading: false,
        });
        if entry.loading {
            return Task::none();
        }
        entry.loading = true;
        let id = id.to_string();
        Task::perform(
            blocking(move || git::diff(&worktree, &base)),
            move |result| Message::DiffLoaded(id.clone(), result),
        )
    }

    fn defer(&mut self, action: Deferred) -> Task<Message> {
        let Some(agent) = self.current() else {
            return Task::none();
        };
        let id = agent.id.clone();
        let label = format!("{} “{}”", action.verb(), agent.title);
        let before = self.row_ids();
        self.pending.retain(|pending| pending.id != id);
        self.pending.push(Pending {
            id: id.clone(),
            action,
            due: Instant::now() + UNDO_WINDOW,
            label,
        });
        self.advance_from(&id, &before)
    }

    fn act(&mut self, id: &str, action: impl FnOnce(&mut Desk) -> Vec<Effect>) -> Task<Message> {
        let before = self.row_ids();
        let effects = action(&mut self.desk);
        let run = self.run(effects);
        Task::batch([run, self.advance_from(id, &before)])
    }

    fn notify(&mut self, text: impl Into<String>) {
        self.toast = Some((text.into(), Instant::now()));
    }

    fn launch(&mut self, template: &str) {
        let Some(agent) = self.current() else { return };
        let path = if agent.worktree.exists() {
            agent.worktree.clone()
        } else {
            self.desk
                .state
                .project(&agent.project_id)
                .map(|project| project.path.clone())
                .unwrap_or_default()
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

    // Palette

    pub fn commands(&self) -> Vec<PaletteCommand> {
        let mut commands = vec![
            PaletteCommand {
                label: "New task".into(),
                keys: "N",
                message: Message::NewTask,
            },
            PaletteCommand {
                label: "Add project…".into(),
                keys: "",
                message: Message::AddProject,
            },
            PaletteCommand {
                label: "Show inbox".into(),
                keys: "",
                message: Message::Show(View::Inbox),
            },
            PaletteCommand {
                label: "Show working".into(),
                keys: "",
                message: Message::Show(View::Working),
            },
            PaletteCommand {
                label: "Show later".into(),
                keys: "",
                message: Message::Show(View::Later),
            },
            PaletteCommand {
                label: "Show done".into(),
                keys: "",
                message: Message::Show(View::Done),
            },
            PaletteCommand {
                label: "Show all tasks".into(),
                keys: "",
                message: Message::Show(View::All),
            },
            PaletteCommand {
                label: if self.show_sidebar {
                    "Hide sidebar"
                } else {
                    "Show sidebar"
                }
                .into(),
                keys: "S",
                message: Message::ToggleSidebar,
            },
            PaletteCommand {
                label: format!("Zoom in (current: {}%)", self.zoom_percent),
                keys: if cfg!(target_os = "macos") {
                    "⌘+"
                } else {
                    "Ctrl++"
                },
                message: Message::ZoomIn,
            },
            PaletteCommand {
                label: format!("Zoom out (current: {}%)", self.zoom_percent),
                keys: if cfg!(target_os = "macos") {
                    "⌘−"
                } else {
                    "Ctrl+-"
                },
                message: Message::ZoomOut,
            },
            PaletteCommand {
                label: "Reset zoom to 100%".into(),
                keys: if cfg!(target_os = "macos") {
                    "⌘0"
                } else {
                    "Ctrl+0"
                },
                message: Message::ResetZoom,
            },
            PaletteCommand {
                label: if self.board {
                    "List view"
                } else {
                    "Board view"
                }
                .into(),
                keys: "B",
                message: Message::ToggleBoard,
            },
            PaletteCommand {
                label: if self.focus {
                    "Leave focus mode"
                } else {
                    "Focus mode"
                }
                .into(),
                keys: "F",
                message: Message::ToggleFocus,
            },
            PaletteCommand {
                label: "Settings".into(),
                keys: "",
                message: Message::OpenSettings,
            },
            PaletteCommand {
                label: "Undo".into(),
                keys: "Z",
                message: Message::Undo,
            },
        ];
        for project in &self.desk.state.projects {
            commands.push(PaletteCommand {
                label: format!("Show project {}", project.name),
                keys: "",
                message: Message::Show(View::Project(project.id.clone())),
            });
        }
        if let View::Project(id) = &self.view {
            commands.push(PaletteCommand {
                label: "Move project up".into(),
                keys: "⌥↑",
                message: Message::MoveProject(id.clone(), -1),
            });
            commands.push(PaletteCommand {
                label: "Move project down".into(),
                keys: "⌥↓",
                message: Message::MoveProject(id.clone(), 1),
            });
        }
        if let Some(agent) = self.current() {
            for priority in Priority::ALL {
                if priority != agent.priority {
                    commands.push(PaletteCommand {
                        label: format!("Priority: {priority}"),
                        keys: "",
                        message: Message::SetPriority(priority),
                    });
                }
            }
            if !agent.status.is_done() {
                commands.push(PaletteCommand {
                    label: "Later…".into(),
                    keys: "L",
                    message: Message::OpenLater,
                });
                commands.push(PaletteCommand {
                    label: "Reply".into(),
                    keys: "R",
                    message: Message::StartReply,
                });
                commands.push(PaletteCommand {
                    label: "Discard".into(),
                    keys: "X",
                    message: Message::Discard,
                });
                commands.push(PaletteCommand {
                    label: "Mark done (keep branch)".into(),
                    keys: "",
                    message: Message::MarkDone,
                });
            }
            match agent.status {
                Status::Review => commands.push(PaletteCommand {
                    label: "Merge".into(),
                    keys: "E",
                    message: Message::Approve,
                }),
                Status::Failed { .. } => commands.push(PaletteCommand {
                    label: "Retry".into(),
                    keys: "E",
                    message: Message::Retry,
                }),
                _ => {}
            }
            if agent.snooze_until.is_some() {
                commands.push(PaletteCommand {
                    label: "Wake now".into(),
                    keys: "",
                    message: Message::WakeNow,
                });
            }
            commands.push(PaletteCommand {
                label: "Open in terminal".into(),
                keys: "",
                message: Message::OpenTerminal,
            });
            commands.push(PaletteCommand {
                label: "Open in editor".into(),
                keys: "",
                message: Message::OpenEditor,
            });
            commands.push(PaletteCommand {
                label: "Show diff".into(),
                keys: "D",
                message: Message::SetTab(Tab::Diff),
            });
            commands.push(PaletteCommand {
                label: "Show transcript".into(),
                keys: "T",
                message: Message::SetTab(Tab::Transcript),
            });
        }
        commands
    }

    pub fn palette_matches(&self) -> Vec<PaletteCommand> {
        let Some(Overlay::Palette(palette)) = &self.overlay else {
            return Vec::new();
        };
        let query = palette.query.to_lowercase();
        self.commands()
            .into_iter()
            .filter(|command| {
                query
                    .split_whitespace()
                    .all(|word| command.label.to_lowercase().contains(word))
            })
            .collect()
    }

    // Update

    pub fn update(&mut self, message: Message) -> Task<Message> {
        let task = self.handle(message);
        if self.desk.take_dirty() && self.save_enabled {
            if let Err(error) = self.store.save(&self.desk.state) {
                self.error = Some(format!("Could not save: {error}"));
            }
        }
        let selection = self.ensure_selection();
        Task::batch([task, selection])
    }

    fn handle(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Supervisor(event) => self.on_supervisor(event),
            Message::Tick => {
                self.now = now();
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
            Message::Key {
                key,
                modifiers,
                captured,
            } => self.on_key(key, modifiers, captured),
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
                let first = self.rows().first().map(|agent| agent.id.clone());
                self.select(first)
            }
            Message::Select(id) => self.select(Some(id)),
            Message::Open(id) => {
                self.board = false;
                let task = self.select(Some(id));
                self.focus = true;
                task
            }
            Message::ToggleBoard => {
                self.board = !self.board;
                self.focus = false;
                Task::none()
            }
            Message::ToggleFocus => {
                self.focus = !self.focus && self.current().is_some();
                self.board = false;
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
                let Some(agent) = self.current() else {
                    return Task::none();
                };
                let id = agent.id.clone();
                match agent.status {
                    Status::Review if index == 0 => self.defer(Deferred::Merge),
                    Status::Review if index == 1 => self.handle(Message::StartReply),
                    Status::Review if index == 2 => self.handle(Message::Discard),
                    Status::Failed { .. } if index == 1 => self.handle(Message::Discard),
                    _ => self.act(&id, |desk| desk.choose(&id, index)),
                }
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
                if self.current().is_none_or(|agent| agent.status.is_done()) {
                    return Task::none();
                }
                self.replying = true;
                self.focus_reply()
            }
            Message::ReplyEdit(action) => {
                self.reply.perform(action);
                Task::none()
            }
            Message::SendReply => {
                let text = self.reply.text();
                let Some(id) = self.selected.clone() else {
                    return Task::none();
                };
                if text.trim().is_empty() {
                    return Task::none();
                }
                self.reply = text_editor::Content::new();
                self.replying = false;
                self.act(&id, |desk| desk.reply(&id, &text))
            }
            Message::CancelReply => {
                self.replying = false;
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
                self.overlay = Some(Overlay::Composer(Composer {
                    project,
                    base,
                    priority: Priority::Medium,
                    content: text_editor::Content::new(),
                    error: None,
                }));
                operation::focus(COMPOSER_ID)
            }
            Message::ComposerProject(id) => {
                let base = self.base_branch(Some(&id));
                if let Some(Overlay::Composer(composer)) = &mut self.overlay {
                    composer.project = Some(id);
                    composer.base = base;
                }
                Task::none()
            }
            Message::ComposerPriority(priority) => {
                if let Some(Overlay::Composer(composer)) = &mut self.overlay {
                    composer.priority = priority;
                }
                Task::none()
            }
            Message::ComposerEdit(action) => {
                if let Some(Overlay::Composer(composer)) = &mut self.overlay {
                    composer.content.perform(action);
                }
                Task::none()
            }
            Message::ComposerSubmit => self.submit_composer(),
            Message::CloseOverlay => {
                self.overlay = None;
                Task::none()
            }
            Message::OpenPalette => {
                self.overlay = Some(Overlay::Palette(Palette {
                    query: String::new(),
                    selected: 0,
                }));
                operation::focus(PALETTE_ID)
            }
            Message::PaletteQuery(query) => {
                if let Some(Overlay::Palette(palette)) = &mut self.overlay {
                    palette.query = query;
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
                    custom: String::new(),
                    error: None,
                }));
                Task::none()
            }
            Message::LaterPreset(preset) => {
                self.snooze(later::preset(preset, chrono::Local::now()).timestamp())
            }
            Message::LaterCustom(text) => {
                if let Some(Overlay::Later(picker)) = &mut self.overlay {
                    picker.custom = text;
                    picker.error = None;
                }
                Task::none()
            }
            Message::LaterSubmit => {
                let Some(Overlay::Later(picker)) = &mut self.overlay else {
                    return Task::none();
                };
                match later::parse(&picker.custom, chrono::Local::now()) {
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
            Message::SetPriority(priority) => {
                let Some(id) = self.selected.clone() else {
                    return Task::none();
                };
                let effects = self.desk.set_priority(&id, priority);
                self.notify(format!("Priority set to {priority}"));
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
            Message::AddProject => Task::perform(
                async {
                    rfd::AsyncFileDialog::new()
                        .set_title("Choose a git repository")
                        .pick_folder()
                        .await
                        .map(|folder| folder.path().to_path_buf())
                },
                Message::ProjectPicked,
            ),
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
                let state = self.diffs.entry(id).or_insert(DiffState {
                    files: Ok(Vec::new()),
                    colors: Vec::new(),
                    selected: 0,
                    loading: false,
                });
                state.loading = false;
                state.files = result.map(|text| git::parse_diff(&text));
                state.colors = match &state.files {
                    Ok(files) => files
                        .iter()
                        .map(|file| crate::highlight::diff_lines(&file.path, &file.lines))
                        .collect(),
                    Err(_) => Vec::new(),
                };
                if let Ok(files) = &state.files {
                    state.selected = state.selected.min(files.len().saturating_sub(1));
                }
                Task::none()
            }
            Message::SelectFile(index) => {
                if let Some(state) = self.selected.as_ref().and_then(|id| self.diffs.get_mut(id)) {
                    state.selected = index;
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
            Message::OpenSettings => {
                let settings = &self.desk.state.settings;
                self.overlay = Some(Overlay::Settings(SettingsForm {
                    slots: settings.slots.to_string(),
                    terminal: settings.terminal_command.clone(),
                    editor: settings.editor_command.clone(),
                    error: None,
                }));
                Task::none()
            }
            Message::SettingsSlots(value) => self.edit_settings(|form| form.slots = value),
            Message::SettingsTerminal(value) => self.edit_settings(|form| form.terminal = value),
            Message::SettingsEditor(value) => self.edit_settings(|form| form.editor = value),
            Message::SaveSettings => {
                let Some(Overlay::Settings(form)) = &mut self.overlay else {
                    return Task::none();
                };
                let Some(slots) = form
                    .slots
                    .trim()
                    .parse::<usize>()
                    .ok()
                    .filter(|slots| (1..=64).contains(slots))
                else {
                    form.error = Some("Running agents must be a number from 1 to 64".into());
                    return Task::none();
                };
                let settings = Settings {
                    slots,
                    terminal_command: form.terminal.trim().to_string(),
                    editor_command: form.editor.trim().to_string(),
                };
                self.overlay = None;
                if settings != self.desk.state.settings {
                    self.desk.state.settings = settings;
                    if self.save_enabled {
                        if let Err(error) = self.store.save(&self.desk.state) {
                            self.error = Some(format!("Could not save: {error}"));
                        }
                    }
                }
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

    fn edit_settings(&mut self, change: impl FnOnce(&mut SettingsForm)) -> Task<Message> {
        if let Some(Overlay::Settings(form)) = &mut self.overlay {
            change(form);
            form.error = None;
        }
        Task::none()
    }

    fn focus_reply(&self) -> Task<Message> {
        operation::focus(REPLY_ID)
    }

    fn snooze(&mut self, until: Timestamp) -> Task<Message> {
        let Some(Overlay::Later(picker)) = self.overlay.take() else {
            return Task::none();
        };
        let before = self.row_ids();
        self.desk.snooze(&picker.agent, Some(until));
        let when = chrono::DateTime::from_timestamp(until, 0)
            .map(|time| {
                time.with_timezone(&chrono::Local)
                    .format("%a %H:%M")
                    .to_string()
            })
            .unwrap_or_default();
        self.notify(format!("Later: {when}"));
        self.advance_from(&picker.agent, &before)
    }

    fn submit_composer(&mut self) -> Task<Message> {
        let Some(Overlay::Composer(composer)) = &mut self.overlay else {
            return Task::none();
        };
        let drafts = compose::split(&composer.content.text());
        if drafts.is_empty() {
            composer.error = Some("Describe the work first".into());
            return Task::none();
        }
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
        let priority = composer.priority;
        let count = drafts.len();
        self.overlay = None;
        let effects = self.desk.file(&project.id, &base, priority, drafts);
        self.notify(if count == 1 {
            "Filed 1 task".to_string()
        } else {
            format!("Filed {count} tasks")
        });
        self.run(effects)
    }

    fn on_supervisor(&mut self, event: supervisor::Event) -> Task<Message> {
        match event {
            supervisor::Event::Ready(handle) => {
                for request in self.backlog.drain(..) {
                    handle.send(request);
                }
                self.supervisor = Some(handle);
                let effects = self.desk.schedule(now());
                self.run(effects)
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

    fn on_key(&mut self, key: Key, modifiers: Modifiers, captured: bool) -> Task<Message> {
        let command = modifiers.command();
        // Zoom is window-wide, even when an editor or overlay owns normal keys.
        if command && !modifiers.alt() {
            let zoom = match key.as_ref() {
                Key::Character("=" | "+") => Some(Message::ZoomIn),
                Key::Character("-") => Some(Message::ZoomOut),
                Key::Character("0") => Some(Message::ResetZoom),
                _ => None,
            };
            if let Some(message) = zoom {
                return self.handle(message);
            }
        }
        // Overlays first: Escape closes them, and they own arrows and Enter.
        if self.overlay.is_some() {
            if key == Key::Named(Named::Escape) {
                self.overlay = None;
                return Task::none();
            }
            let count = self.palette_matches().len();
            match &mut self.overlay {
                Some(Overlay::Palette(palette)) => match key {
                    Key::Named(Named::ArrowDown) => {
                        palette.selected = (palette.selected + 1).min(count.saturating_sub(1))
                    }
                    Key::Named(Named::ArrowUp) => {
                        palette.selected = palette.selected.saturating_sub(1)
                    }
                    Key::Named(Named::Enter) => {
                        let index = palette.selected;
                        return self.handle(Message::PaletteRun(index));
                    }
                    _ => {}
                },
                Some(Overlay::Later(_)) if !captured => {
                    if let Key::Character(c) = &key {
                        if let Some(preset) = c
                            .parse::<usize>()
                            .ok()
                            .and_then(|n| later::Preset::ALL.get(n.wrapping_sub(1)))
                        {
                            return self.handle(Message::LaterPreset(*preset));
                        }
                    }
                }
                Some(Overlay::ConfirmDiscard(_)) if !captured => {
                    if key == Key::Named(Named::Enter) || key == Key::Character("x".into()) {
                        return self.handle(Message::ConfirmDiscard);
                    }
                }
                _ => {}
            }
            return Task::none();
        }
        if command && key == Key::Character("k".into()) {
            return self.handle(Message::OpenPalette);
        }
        if captured {
            return Task::none();
        }
        if modifiers.alt() {
            if let View::Project(id) = &self.view {
                let id = id.clone();
                match key {
                    Key::Named(Named::ArrowUp) => return self.handle(Message::MoveProject(id, -1)),
                    Key::Named(Named::ArrowDown) => {
                        return self.handle(Message::MoveProject(id, 1));
                    }
                    _ => {}
                }
            }
        }
        if command || modifiers.control() || modifiers.alt() {
            return Task::none();
        }
        match key.as_ref() {
            Key::Named(Named::ArrowDown) => self.move_selection(1),
            Key::Named(Named::ArrowUp) => self.move_selection(-1),
            Key::Named(Named::Enter) => match self.selected.clone() {
                Some(id) => self.handle(Message::Open(id)),
                None => Task::none(),
            },
            Key::Named(Named::Escape) => {
                if self.replying {
                    self.replying = false;
                } else if self.focus {
                    self.focus = false;
                } else if self.board {
                    self.board = false;
                }
                Task::none()
            }
            Key::Character(c) => match c.to_lowercase().as_str() {
                "j" => self.move_selection(1),
                "k" => self.move_selection(-1),
                "e" => self.handle(Message::Approve),
                "r" => self.handle(Message::StartReply),
                "n" => self.handle(Message::NewTask),
                "l" => self.handle(Message::OpenLater),
                "z" => self.handle(Message::Undo),
                "f" => self.handle(Message::ToggleFocus),
                "b" => self.handle(Message::ToggleBoard),
                "s" => self.handle(Message::ToggleSidebar),
                "d" => self.handle(Message::SetTab(Tab::Diff)),
                "t" => self.handle(Message::SetTab(Tab::Transcript)),
                "x" => self.handle(Message::Discard),
                digit => match digit.parse::<usize>() {
                    Ok(n) if (1..=9).contains(&n) => self.handle(Message::Choose(n - 1)),
                    _ => Task::none(),
                },
            },
            _ => Task::none(),
        }
    }

    pub fn view(&self) -> Element<'_, Message> {
        crate::views::root(self)
    }
}
