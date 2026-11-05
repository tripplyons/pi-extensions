//! The agent lifecycle, independent of the window. Methods change state and
//! return [`Effect`]s (process requests and git jobs) for the app to run, so
//! the whole flow can be tested without iced, Pi, or git.

use crate::compose::Draft;
use crate::git::Merge;
use crate::model::*;
use crate::order;
use crate::rpc::{self, Incoming, UiRequest};
use crate::summary;
use crate::supervisor::Spawn;
use crate::transcript::Transcript;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The `ask_user` entry that opens free-text input after a `select`.
pub const OTHER: &str = "Other (type an answer)";

const RESUME: &str =
    "pi-desk restarted while you were working. Continue the task from where you left off.";

#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Spawn(Spawn),
    Send {
        agent: Id,
        line: String,
    },
    Close {
        agent: Id,
    },
    Kill {
        agent: Id,
    },
    CreateWorktree {
        agent: Id,
        repo: PathBuf,
        path: PathBuf,
        branch: String,
        base: String,
    },
    GenerateCommitMessage {
        agent: Id,
        program: String,
        worktree: PathBuf,
        base: String,
        title: String,
        summary: String,
    },
    /// Commits a main-checkout task's remaining changes onto `base`.
    Commit {
        agent: Id,
        checkout: PathBuf,
        base: String,
        message: String,
    },
    Merge {
        agent: Id,
        repo: PathBuf,
        worktree: PathBuf,
        branch: String,
        base: String,
        message: String,
    },
    Remove {
        agent: Id,
        repo: PathBuf,
        worktree: PathBuf,
        branch: String,
        keep_branch: bool,
        outcome: Outcome,
    },
}

#[derive(Debug, Clone, PartialEq)]
struct Ask {
    question: String,
    choices: Vec<String>,
    recommended: Option<usize>,
}

/// Process facts that are not saved.
#[derive(Debug, Default)]
struct Runtime {
    generation: u64,
    live: bool,
    /// Stdin was closed or the process was killed on purpose.
    closing: bool,
    streaming: bool,
    compacting: bool,
    /// Awaiting startup state before sending any prompt; true means resume.
    starting: Option<bool>,
    /// A round-trip idle check, invalidated when more work starts.
    settling: Option<(String, Option<String>)>,
    ask: Option<Ask>,
    /// Free text to send when the `input` after "Other" arrives.
    other_text: Option<String>,
    preparing: bool,
    busy: Option<&'static str>,
    /// The outstanding settings command and the last confirmed selection.
    configuring: Option<(String, SessionSettings)>,
    deferred_idle: Option<Option<String>>,
}

#[derive(Debug, Clone)]
enum Undo {
    Snooze { agent: Id, until: Option<Timestamp> },
    Projects(Vec<Project>),
}

/// How filed tasks get their working copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Isolation {
    Worktree,
    /// Work in the project's checkout, measured from commit `start`.
    Main {
        start: String,
    },
}

pub struct Desk {
    pub state: State,
    pub transcripts: HashMap<Id, Transcript>,
    runtime: HashMap<Id, Runtime>,
    undo: Vec<Undo>,
    pi_program: String,
    worktree_root: PathBuf,
    next_generation: u64,
    next_request: u64,
    dirty: bool,
}

fn slug(text: &str, max: usize) -> String {
    let mut slug = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= max {
            break;
        }
    }
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() { "task".into() } else { slug }
}

impl Desk {
    pub fn new(
        mut state: State,
        pi_program: impl Into<String>,
        worktree_root: impl Into<PathBuf>,
    ) -> Self {
        // Processes do not survive the app. Work in progress resumes from the
        // session file; open questions stay answerable through a prompt.
        for agent in &mut state.agents {
            if agent.status == Status::Working {
                agent.status = Status::Queued;
                if agent.outbox.is_none() {
                    agent.outbox = Some(Outbox {
                        text: RESUME.into(),
                        kind: OutboxKind::Resume,
                    });
                }
            }
        }
        Desk {
            state,
            transcripts: HashMap::new(),
            runtime: HashMap::new(),
            undo: Vec::new(),
            pi_program: pi_program.into(),
            worktree_root: worktree_root.into(),
            next_generation: 0,
            next_request: 0,
            dirty: false,
        }
    }

    /// True once since the last call if saved state changed.
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.runtime.get(id).is_some_and(|runtime| runtime.live)
    }

    /// A short label for slow app-side work on a row, such as merging.
    pub fn busy(&self, id: &str) -> Option<&'static str> {
        self.runtime.get(id).and_then(|runtime| runtime.busy)
    }

    pub fn running(&self) -> usize {
        self.state
            .agents
            .iter()
            .filter(|agent| agent.status == Status::Working && self.is_live(&agent.id))
            .count()
    }

    fn rt(&mut self, id: &str) -> &mut Runtime {
        self.runtime.entry(id.to_string()).or_default()
    }

    fn request_id(&mut self, kind: &str) -> String {
        self.next_request += 1;
        format!("{kind}-{}", self.next_request)
    }

    fn edit(&mut self, id: &str, change: impl FnOnce(&mut Agent)) -> bool {
        let Some(agent) = self.state.agent_mut(id) else {
            return false;
        };
        change(agent);
        agent.touch();
        self.dirty = true;
        true
    }

    /// Reverts the latest local change (snooze, project order).
    pub fn undo(&mut self) -> bool {
        let Some(undo) = self.undo.pop() else {
            return false;
        };
        match undo {
            Undo::Snooze { agent, until } => {
                self.edit(&agent, |agent| agent.snooze_until = until);
            }
            Undo::Projects(projects) => self.state.projects = projects,
        }
        self.dirty = true;
        true
    }

    // Projects

    pub fn add_project(&mut self, path: &Path) -> Result<Id, String> {
        let root = crate::git::toplevel(path)
            .map_err(|_| format!("{} is not inside a git repository", path.display()))?;
        if let Some(existing) = self
            .state
            .projects
            .iter()
            .find(|project| project.path == root)
        {
            return Ok(existing.id.clone());
        }
        let name = root
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| root.display().to_string());
        let id = new_id();
        self.state.projects.push(Project {
            id: id.clone(),
            name,
            path: root,
        });
        self.dirty = true;
        Ok(id)
    }

    /// Moves a project up (`-1`) or down (`1`) in rank.
    pub fn move_project(&mut self, id: &str, delta: isize) {
        let Some(index) = self
            .state
            .projects
            .iter()
            .position(|project| project.id == id)
        else {
            return;
        };
        let target =
            (index as isize + delta).clamp(0, self.state.projects.len() as isize - 1) as usize;
        if target != index {
            self.undo.push(Undo::Projects(self.state.projects.clone()));
            let project = self.state.projects.remove(index);
            self.state.projects.insert(target, project);
            self.dirty = true;
        }
    }

    pub fn place_project(&mut self, id: &str, target: usize) {
        let Some(index) = self
            .state
            .projects
            .iter()
            .position(|project| project.id == id)
        else {
            return;
        };
        let target = target.min(self.state.projects.len() - 1);
        if target != index {
            self.undo.push(Undo::Projects(self.state.projects.clone()));
            let project = self.state.projects.remove(index);
            self.state.projects.insert(target, project);
            self.dirty = true;
        }
    }

    // Filing

    /// Files drafts as queued agents. `base` is the branch their work lands on.
    pub fn file(
        &mut self,
        project_id: &str,
        base: &str,
        isolation: Isolation,
        session_settings: SessionSettings,
        drafts: Vec<Draft>,
    ) -> Vec<Effect> {
        let Some(project) = self.state.project(project_id).cloned() else {
            return Vec::new();
        };
        let mut effects = Vec::new();
        for draft in drafts {
            let id = new_id();
            let short = &id[id.len() - 6..];
            let name = format!("{}-{short}", slug(&draft.title, 40));
            let at = now();
            let agent = Agent {
                id: id.clone(),
                project_id: project.id.clone(),
                title: draft.title,
                prompt: draft.prompt.clone(),
                session_settings: session_settings.clone(),
                status: Status::Queued,
                created_at: at,
                updated_at: at,
                inbox_at: None,
                base_branch: base.to_string(),
                workspace: match &isolation {
                    Isolation::Worktree => Workspace::Worktree {
                        worktree: self.worktree_root.join(slug(&project.name, 40)).join(&name),
                        branch: format!("pi-desk/{name}"),
                    },
                    Isolation::Main { start } => Workspace::Main {
                        checkout: project.path.clone(),
                        start: start.clone(),
                    },
                },
                session_id: new_id(),
                session_file: None,
                summary: None,
                question: None,
                outbox: Some(Outbox {
                    text: draft.prompt,
                    kind: OutboxKind::Initial,
                }),
                snooze_until: None,
                note: None,
                started: false,
            };
            self.state.agents.push(agent);
        }
        self.dirty = true;
        effects.extend(self.schedule(now()));
        effects
    }

    fn prepare(&mut self, agent: &Agent) -> Option<Effect> {
        let Workspace::Worktree { worktree, branch } = &agent.workspace else {
            return None;
        };
        self.rt(&agent.id).preparing = true;
        let repo = self
            .state
            .project(&agent.project_id)
            .map(|project| project.path.clone())
            .unwrap_or_default();
        Some(Effect::CreateWorktree {
            agent: agent.id.clone(),
            repo,
            path: worktree.clone(),
            branch: branch.clone(),
            base: agent.base_branch.clone(),
        })
    }

    pub fn on_worktree(&mut self, id: &str, result: Result<(), String>) -> Vec<Effect> {
        self.rt(id).preparing = false;
        if let Err(error) = result {
            self.edit(id, |agent| {
                agent.status = Status::Failed {
                    error: format!("Could not create the worktree: {error}"),
                };
                agent.inbox_at = Some(now());
            });
        }
        self.schedule(now())
    }

    // Scheduling

    /// Starts queued agents while slots are free, preparing missing worktrees.
    pub fn schedule(&mut self, at: Timestamp) -> Vec<Effect> {
        let mut effects = Vec::new();
        let missing: Vec<Agent> = self
            .state
            .agents
            .iter()
            .filter(|agent| agent.status == Status::Queued && !agent.workspace.path().exists())
            .filter(|agent| {
                !self
                    .runtime
                    .get(&agent.id)
                    .is_some_and(|runtime| runtime.preparing)
            })
            .cloned()
            .collect();
        for agent in &missing {
            let prepared = if agent.started {
                None
            } else {
                self.prepare(agent)
            };
            match prepared {
                Some(effect) => effects.push(effect),
                None => {
                    self.edit(&agent.id, |agent| {
                        let kind = match agent.workspace {
                            Workspace::Worktree { .. } => "worktree",
                            Workspace::Main { .. } => "checkout",
                        };
                        agent.status = Status::Failed {
                            error: format!(
                                "The {kind} at {} is missing",
                                agent.workspace.path().display()
                            ),
                        };
                        agent.inbox_at = Some(now());
                    });
                }
            }
        }
        let ready: Vec<Id> = order::to_start(&self.state, self.running(), at)
            .into_iter()
            .filter(|id| {
                self.state
                    .agent(id)
                    .is_some_and(|agent| agent.workspace.path().exists())
            })
            .collect();
        for id in ready {
            effects.extend(self.spawn(&id));
        }
        effects
    }

    fn spawn(&mut self, id: &str) -> Vec<Effect> {
        let Some(agent) = self.state.agent(id).cloned() else {
            return Vec::new();
        };
        self.next_generation += 1;
        let generation = self.next_generation;
        *self.rt(id) = Runtime {
            generation,
            live: true,
            starting: Some(agent.started),
            ..Runtime::default()
        };
        let resumed = agent.started;
        self.edit(id, |agent| {
            agent.status = Status::Working;
            agent.started = true;
        });
        if !resumed {
            self.transcripts
                .insert(id.to_string(), Transcript::default());
        }
        let mut effects = vec![Effect::Spawn(Spawn {
            agent: id.to_string(),
            generation,
            program: self.pi_program.clone(),
            args: [
                "--mode".into(),
                "rpc".into(),
                "--session-id".into(),
                agent.session_id.clone(),
                "--append-system-prompt".into(),
                summary::system_prompt(&agent.workspace),
            ]
            .into_iter()
            .chain(agent.session_settings.args())
            .collect(),
            cwd: agent.workspace.path().to_path_buf(),
            env: vec![
                ("PI_ASK_USER_TIMEOUT".into(), "0".into()),
                ("PI_DESK".into(), "1".into()),
            ],
        })];
        effects.push(Effect::Send {
            agent: id.to_string(),
            line: rpc::command("startup", "get_state"),
        });
        effects
    }

    fn send_outbox(&mut self, id: &str) -> Vec<Effect> {
        let Some(outbox) = self.state.agent(id).and_then(|agent| agent.outbox.clone()) else {
            return Vec::new();
        };
        self.edit(id, |agent| agent.outbox = None);
        let request = self.request_id("prompt");
        vec![Effect::Send {
            agent: id.to_string(),
            line: rpc::prompt(&request, &outbox.text, None),
        }]
    }

    // Process events

    pub fn on_lines(&mut self, id: &str, generation: u64, lines: &[String]) -> Vec<Effect> {
        if self.runtime.get(id).map(|runtime| runtime.generation) != Some(generation) {
            return Vec::new();
        }
        let mut effects = Vec::new();
        for line in lines {
            let Ok(event) = rpc::parse(line) else {
                continue;
            };
            effects.extend(self.on_event(id, event));
        }
        effects
    }

    fn on_event(&mut self, id: &str, event: Incoming) -> Vec<Effect> {
        self.transcripts
            .entry(id.to_string())
            .or_default()
            .apply(&event);
        match event {
            Incoming::Response {
                id: Some(request),
                success,
                data,
                error,
                ..
            } => {
                let starting = if request == "startup" {
                    let Some(resumed) = self.rt(id).starting.take() else {
                        return Vec::new();
                    };
                    if !success {
                        return self.fail(
                            id,
                            error.unwrap_or_else(|| "Could not read Pi's startup settings".into()),
                        );
                    }
                    let actual = SessionSettings::from_state(&data);
                    let requested = self
                        .state
                        .agent(id)
                        .and_then(|agent| agent.session_settings.model.as_ref());
                    if actual.model.is_none()
                        || requested.is_some_and(|model| actual.model.as_ref() != Some(model))
                    {
                        return self.fail(id, "Pi could not restore this task's model. Select an available model and retry.".into());
                    }
                    Some(resumed)
                } else {
                    None
                };
                if self
                    .rt(id)
                    .configuring
                    .as_ref()
                    .is_some_and(|(pending, _)| pending == &request)
                {
                    let (_, previous) = self.rt(id).configuring.take().unwrap();
                    if !success {
                        self.edit(id, |agent| {
                            agent.session_settings = previous;
                            agent.note = Some(
                                error.unwrap_or_else(|| "Pi rejected the settings change".into()),
                            );
                        });
                        let mut effects = vec![Effect::Send {
                            agent: id.into(),
                            line: rpc::command("state", "get_state"),
                        }];
                        effects.extend(self.finish_configuration(id));
                        return effects;
                    }
                    if request.starts_with("model-") {
                        return self.send_effort(id, previous);
                    }
                    if request.starts_with("effort-") {
                        let request = self.request_id("settings");
                        self.rt(id).configuring = Some((request.clone(), previous));
                        return vec![Effect::Send {
                            agent: id.into(),
                            line: rpc::command(&request, "get_state"),
                        }];
                    }
                    self.capture_settings(id, &data);
                    return self.finish_configuration(id);
                }
                if (request == "state" || request == "startup")
                    && success
                    && self.rt(id).configuring.is_none()
                {
                    self.capture_settings(id, &data);
                }
                if (request == "state"
                    || request == "startup"
                    || self
                        .rt(id)
                        .settling
                        .as_ref()
                        .is_some_and(|(pending, _)| pending == &request))
                    && success
                {
                    if let Some(file) = data.get("sessionFile").and_then(Value::as_str) {
                        let file = PathBuf::from(file);
                        if self
                            .state
                            .agent(id)
                            .is_some_and(|agent| agent.session_file.as_ref() != Some(&file))
                        {
                            self.edit(id, |agent| agent.session_file = Some(file));
                        }
                    }
                    if let Some(name) = data
                        .get("sessionName")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        && self
                            .state
                            .agent(id)
                            .is_some_and(|agent| agent.title != name)
                    {
                        self.edit(id, |agent| agent.title = name.to_string());
                    }
                }
                if let Some(resumed) = starting {
                    return if resumed {
                        vec![Effect::Send {
                            agent: id.into(),
                            line: rpc::command("messages", "get_messages"),
                        }]
                    } else {
                        self.send_outbox(id)
                    };
                }
                if request == "messages" {
                    if let Some(messages) = data.get("messages").and_then(Value::as_array) {
                        self.transcripts
                            .insert(id.to_string(), Transcript::from_messages(messages.iter()));
                    }
                    return self.send_outbox(id);
                } else if request.starts_with("settle") {
                    let Some((pending, fallback_error)) = self.rt(id).settling.clone() else {
                        return Vec::new();
                    };
                    if pending != request {
                        return Vec::new();
                    }
                    self.rt(id).settling = None;
                    if self.rt(id).configuring.is_some() {
                        self.rt(id).deferred_idle = Some(fallback_error);
                        return Vec::new();
                    }
                    if !self
                        .state
                        .agent(id)
                        .is_some_and(|agent| agent.status == Status::Working)
                    {
                        return Vec::new();
                    }
                    if !success {
                        return self.fail(
                            id,
                            error.unwrap_or_else(|| "Could not confirm Pi is idle".into()),
                        );
                    }
                    if self.rt(id).compacting
                        || data.get("isStreaming") == Some(&Value::Bool(true))
                        || data.get("isCompacting") == Some(&Value::Bool(true))
                        || data
                            .get("pendingMessageCount")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                            > 0
                    {
                        return Vec::new();
                    }
                    return self.settle(id, fallback_error);
                } else if request.starts_with("prompt") && !success {
                    let error = error.unwrap_or_else(|| "Pi rejected the prompt".into());
                    return self.fail(id, error);
                }
            }
            Incoming::NamingFinished => {
                return vec![Effect::Send {
                    agent: id.into(),
                    line: rpc::command("state", "get_state"),
                }];
            }
            Incoming::AgentStart => {
                self.rt(id).streaming = true;
                self.rt(id).settling = None;
            }
            Incoming::CompactionStart => {
                self.rt(id).compacting = true;
                self.rt(id).settling = None;
            }
            Incoming::CompactionEnd { aborted, error } => {
                self.rt(id).compacting = false;
                let error = error.or_else(|| aborted.then(|| "Compaction was cancelled".into()));
                return self.check_idle(id, error);
            }
            Incoming::ToolStart { name, args, .. } if name == "ask_user" => {
                let strings = |key: &str| -> Vec<String> {
                    args.get(key)
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                };
                let choices = strings("choices");
                let recommended = args
                    .get("recommended")
                    .and_then(Value::as_u64)
                    .map(|number| number as usize)
                    .filter(|number| *number >= 1 && *number <= choices.len())
                    .map(|number| number - 1);
                let question = args
                    .get("question")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                self.rt(id).ask = Some(Ask {
                    question,
                    choices,
                    recommended,
                });
            }
            Incoming::ToolEnd { name, .. } if name == "ask_user" => {
                self.rt(id).ask = None;
                self.rt(id).other_text = None;
                // A question still open here timed out or was cancelled. It
                // stays answerable; the answer goes out as a prompt.
                if self.state.agent(id).is_some_and(|agent| {
                    agent
                        .question
                        .as_ref()
                        .is_some_and(|q| q.request_id.is_some())
                }) {
                    self.edit(id, |agent| {
                        if let Some(question) = &mut agent.question {
                            question.request_id = None;
                        }
                    });
                }
            }
            Incoming::Ui(request) => return self.on_ui(id, request),
            Incoming::AgentSettled { aborted } => {
                self.rt(id).streaming = false;
                return self.check_idle(id, aborted.then(|| "Pi run was aborted".into()));
            }
            _ => {}
        }
        Vec::new()
    }

    fn ask_question(&mut self, id: &str, question: Question) {
        self.edit(id, |agent| {
            agent.question = Some(question);
            agent.status = Status::Question;
            agent.inbox_at = Some(now());
        });
    }

    fn on_ui(&mut self, id: &str, request: UiRequest) -> Vec<Effect> {
        let ask = self.rt(id).ask.clone();
        let base = |text: String, choices: Vec<String>, recommended, kind| Question {
            text,
            choices,
            recommended,
            kind,
            request_id: Some(request.id.clone()),
            asked_at: now(),
        };
        match request.method.as_str() {
            "select" => {
                let question = match ask
                    .filter(|ask| ask.question == request.title && !ask.choices.is_empty())
                {
                    Some(ask) => base(
                        ask.question,
                        ask.choices,
                        ask.recommended,
                        QuestionKind::AskChoices,
                    ),
                    None => base(
                        request.title.clone(),
                        request.options.clone(),
                        None,
                        QuestionKind::Select,
                    ),
                };
                self.ask_question(id, question);
            }
            "input" | "editor" => {
                if let Some(text) = self.rt(id).other_text.take() {
                    return vec![Effect::Send {
                        agent: id.to_string(),
                        line: rpc::ui_value(&request.id, &text),
                    }];
                }
                let text = if request.title.is_empty() {
                    request.message.clone()
                } else {
                    request.title.clone()
                };
                self.ask_question(id, base(text, Vec::new(), None, QuestionKind::FreeText));
            }
            "confirm" => {
                let text = [request.title.as_str(), request.message.as_str()]
                    .iter()
                    .filter(|part| !part.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n\n");
                self.ask_question(
                    id,
                    base(
                        text,
                        vec!["Yes".into(), "No".into()],
                        None,
                        QuestionKind::Confirm,
                    ),
                );
            }
            "notify" => self
                .transcripts
                .entry(id.to_string())
                .or_default()
                .note(request.message),
            _ => {}
        }
        Vec::new()
    }

    /// Native manual compaction aborts a run before it emits compaction_start.
    /// A get_state round trip lets Pi finish that transition (and compaction's
    /// onComplete continuation) before we decide whether to close its stdin.
    /// Open questions only refresh session metadata; they remain answerable.
    fn check_idle(&mut self, id: &str, error: Option<String>) -> Vec<Effect> {
        if self.configuring(id) {
            self.rt(id).deferred_idle = Some(error);
            return Vec::new();
        }
        if self.rt(id).compacting
            || !self
                .state
                .agent(id)
                .is_some_and(|agent| matches!(agent.status, Status::Working | Status::Question))
        {
            return Vec::new();
        }
        let request = self.request_id("settle");
        self.rt(id).settling = Some((request.clone(), error));
        vec![Effect::Send {
            agent: id.to_string(),
            line: rpc::command(&request, "get_state"),
        }]
    }

    fn settle(&mut self, id: &str, fallback_error: Option<String>) -> Vec<Effect> {
        self.rt(id).streaming = false;
        let Some(agent) = self.state.agent(id) else {
            return Vec::new();
        };
        if agent.status != Status::Working {
            return Vec::new();
        }
        // A message queued while the agent was running keeps it going.
        if agent.outbox.is_some() {
            return self.send_outbox(id);
        }
        let transcript = self.transcripts.get(id);
        let error = fallback_error
            .or_else(|| transcript.and_then(|transcript| transcript.last_error.clone()));
        let parsed = transcript.and_then(|transcript| summary::parse(&transcript.last_text));
        self.rt(id).closing = true;
        let mut effects = vec![Effect::Close {
            agent: id.to_string(),
        }];
        match error {
            Some(error) => effects.extend(self.fail(id, error)),
            None => {
                self.edit(id, |agent| {
                    agent.status = Status::Review;
                    agent.summary = parsed;
                    agent.inbox_at = Some(now());
                    agent.note = None;
                });
                effects.extend(self.schedule(now()));
            }
        }
        effects
    }

    fn fail(&mut self, id: &str, error: String) -> Vec<Effect> {
        let live = self.is_live(id);
        self.rt(id).closing = true;
        self.edit(id, |agent| {
            agent.status = Status::Failed { error };
            agent.inbox_at = Some(now());
        });
        let mut effects = if live {
            vec![Effect::Close {
                agent: id.to_string(),
            }]
        } else {
            Vec::new()
        };
        effects.extend(self.schedule(now()));
        effects
    }

    pub fn on_exit(
        &mut self,
        id: &str,
        generation: u64,
        code: Option<i32>,
        stderr: &str,
    ) -> Vec<Effect> {
        let Some(runtime) = self
            .runtime
            .get_mut(id)
            .filter(|runtime| runtime.generation == generation)
        else {
            return Vec::new();
        };
        runtime.live = false;
        runtime.streaming = false;
        runtime.starting = None;
        runtime.configuring = None;
        runtime.deferred_idle = None;
        let expected = runtime.closing;
        let status = self.state.agent(id).map(|agent| agent.status.clone());
        match status {
            Some(Status::Question) => {
                self.edit(id, |agent| {
                    if let Some(question) = &mut agent.question {
                        question.request_id = None;
                    }
                });
            }
            Some(Status::Working) if !expected => {
                let tail: String = stderr
                    .lines()
                    .rev()
                    .take(6)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n");
                let code = code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "a signal".into());
                let error = if tail.is_empty() {
                    format!("Pi exited with {code}")
                } else {
                    format!("Pi exited with {code}:\n{tail}")
                };
                return self.fail(id, error);
            }
            _ => {}
        }
        self.schedule(now())
    }

    pub fn on_spawn_failed(&mut self, id: &str, generation: u64, error: String) -> Vec<Effect> {
        if self.runtime.get(id).map(|runtime| runtime.generation) != Some(generation) {
            return Vec::new();
        }
        self.rt(id).live = false;
        self.fail(id, error)
    }

    // User actions

    /// Picks a numbered choice (0-based) on a question or review card.
    pub fn choose(&mut self, id: &str, index: usize) -> Vec<Effect> {
        let Some(agent) = self.state.agent(id).cloned() else {
            return Vec::new();
        };
        match agent.status {
            Status::Question => {
                let Some(question) = agent.question.clone() else {
                    return Vec::new();
                };
                let Some(choice) = question.choices.get(index).cloned() else {
                    return Vec::new();
                };
                match (&question.request_id, self.is_live(id)) {
                    (Some(request), true) => {
                        let line = match question.kind {
                            QuestionKind::Confirm => rpc::ui_confirm(request, index == 0),
                            _ => rpc::ui_value(request, &choice),
                        };
                        self.resume_working(id);
                        vec![Effect::Send {
                            agent: id.to_string(),
                            line,
                        }]
                    }
                    _ => self.answer_later(id, &question.text, &choice),
                }
            }
            Status::Review => match index {
                0 => self.approve(id),
                _ => Vec::new(),
            },
            Status::Failed { .. } => match index {
                0 => self.retry(id),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    fn resume_working(&mut self, id: &str) {
        self.edit(id, |agent| {
            agent.question = None;
            agent.status = Status::Working;
            agent.inbox_at = None;
        });
    }

    fn answer_later(&mut self, id: &str, question: &str, answer: &str) -> Vec<Effect> {
        let text = format!("Answer to your earlier question \"{question}\": {answer}");
        self.edit(id, |agent| {
            agent.question = None;
            agent.outbox = Some(Outbox {
                text,
                kind: OutboxKind::Answer,
            });
            agent.status = Status::Queued;
            agent.inbox_at = None;
        });
        self.schedule(now())
    }

    /// E: the card's recommended action.
    pub fn approve(&mut self, id: &str) -> Vec<Effect> {
        if self.busy(id).is_some() {
            return Vec::new();
        }
        let Some(agent) = self.state.agent(id).cloned() else {
            return Vec::new();
        };
        match agent.status {
            Status::Question => {
                let index = agent
                    .question
                    .as_ref()
                    .and_then(|question| question.recommended)
                    .unwrap_or(0);
                self.choose(id, index)
            }
            Status::Failed { .. } => self.retry(id),
            Status::Review => {
                self.rt(id).busy = Some("Writing commit message");
                self.edit(id, |agent| agent.note = None);
                vec![Effect::GenerateCommitMessage {
                    agent: id.to_string(),
                    program: self.pi_program.clone(),
                    worktree: agent.workspace.path().to_path_buf(),
                    base: agent.diff_base().to_string(),
                    title: agent.title,
                    summary: agent.summary.map(|summary| summary.did).unwrap_or_default(),
                }]
            }
            _ => Vec::new(),
        }
    }

    pub fn on_commit_message(
        &mut self,
        id: &str,
        result: Result<Option<String>, String>,
    ) -> Vec<Effect> {
        if self.busy(id) != Some("Writing commit message") {
            return Vec::new();
        }
        self.rt(id).busy = None;
        let Some(agent) = self.state.agent(id).cloned() else {
            return Vec::new();
        };
        if agent.status != Status::Review {
            return Vec::new();
        }
        match result {
            Ok(None) => self.on_merged(id, Ok(Merge::NoChanges)),
            Ok(Some(message)) => {
                let Some(project) = self.state.project(&agent.project_id) else {
                    return Vec::new();
                };
                let repo = project.path.clone();
                match agent.workspace {
                    Workspace::Worktree { worktree, branch } => {
                        self.rt(id).busy = Some("Merging");
                        vec![Effect::Merge {
                            agent: id.to_string(),
                            repo,
                            worktree,
                            branch,
                            base: agent.base_branch,
                            message,
                        }]
                    }
                    Workspace::Main { checkout, .. } => {
                        self.rt(id).busy = Some("Committing");
                        vec![Effect::Commit {
                            agent: id.to_string(),
                            checkout,
                            base: agent.base_branch,
                            message,
                        }]
                    }
                }
            }
            Err(error) => {
                self.edit(id, |agent| {
                    agent.note = Some(format!("Could not write commit message: {error}"));
                });
                Vec::new()
            }
        }
    }

    pub fn on_merged(&mut self, id: &str, result: Result<Merge, String>) -> Vec<Effect> {
        self.rt(id).busy = None;
        let Some(agent) = self.state.agent(id).cloned() else {
            return Vec::new();
        };
        match result {
            Ok(Merge::Merged { .. }) | Ok(Merge::NoChanges) => {
                self.remove(id, false, Outcome::Merged)
            }
            Ok(Merge::Conflict { files }) => {
                let Workspace::Worktree { branch, .. } = &agent.workspace else {
                    return Vec::new();
                };
                let list = if files.is_empty() {
                    "some files".to_string()
                } else {
                    files.join(", ")
                };
                let text = format!(
                    "Squash-merging your branch into {} conflicts in: {list}. Rebase {} onto {}, resolve the conflicts, run the checks, and commit.",
                    agent.base_branch, branch, agent.base_branch
                );
                self.edit(id, |agent| {
                    agent.note = Some(format!("Merge conflict in {list}; sent back to rebase"));
                    agent.outbox = Some(Outbox {
                        text,
                        kind: OutboxKind::Reply,
                    });
                    agent.status = Status::Queued;
                    agent.inbox_at = None;
                });
                self.schedule(now())
            }
            Err(error) => {
                self.edit(id, |agent| agent.note = Some(error));
                Vec::new()
            }
        }
    }

    fn remove(&mut self, id: &str, keep_branch: bool, outcome: Outcome) -> Vec<Effect> {
        let Some(agent) = self.state.agent(id).cloned() else {
            return Vec::new();
        };
        let repo = self
            .state
            .project(&agent.project_id)
            .map(|project| project.path.clone())
            .unwrap_or_default();
        let mut effects = Vec::new();
        if self.is_live(id) {
            self.rt(id).closing = true;
            effects.push(Effect::Kill {
                agent: id.to_string(),
            });
        }
        match agent.workspace {
            Workspace::Worktree { worktree, branch } => {
                self.rt(id).busy = Some("Cleaning up");
                effects.push(Effect::Remove {
                    agent: id.to_string(),
                    repo,
                    worktree,
                    branch,
                    keep_branch,
                    outcome,
                });
            }
            // The user's checkout is never cleaned up; its files stay as they are.
            Workspace::Main { .. } => effects.extend(self.on_removed(id, outcome, Ok(()))),
        }
        effects
    }

    pub fn on_removed(
        &mut self,
        id: &str,
        outcome: Outcome,
        result: Result<(), String>,
    ) -> Vec<Effect> {
        self.rt(id).busy = None;
        self.edit(id, |agent| {
            agent.status = Status::Done { outcome };
            agent.question = None;
            agent.outbox = None;
            agent.inbox_at = None;
            agent.snooze_until = None;
            agent.note = result.err().map(|error| format!("Cleanup failed: {error}"));
        });
        self.schedule(now())
    }

    /// X: stop the agent and delete its worktree and branch. A main-checkout
    /// task keeps its files.
    pub fn discard(&mut self, id: &str) -> Vec<Effect> {
        if self.busy(id).is_some() {
            return Vec::new();
        }
        if self
            .state
            .agent(id)
            .is_none_or(|agent| agent.status.is_done())
        {
            return Vec::new();
        }
        self.remove(id, false, Outcome::Discarded)
    }

    /// Close without merging. The branch stays for later use.
    pub fn mark_done(&mut self, id: &str) -> Vec<Effect> {
        if self.busy(id).is_some() {
            return Vec::new();
        }
        if self
            .state
            .agent(id)
            .is_none_or(|agent| agent.status.is_done())
        {
            return Vec::new();
        }
        self.remove(id, true, Outcome::Closed)
    }

    pub fn retry(&mut self, id: &str) -> Vec<Effect> {
        if self.busy(id).is_some() {
            return Vec::new();
        }
        self.edit(id, |agent| {
            if agent.outbox.is_none() {
                agent.outbox = Some(if agent.started {
                    Outbox {
                        text: "Your last run failed. Check what happened and continue the task."
                            .into(),
                        kind: OutboxKind::Resume,
                    }
                } else {
                    Outbox {
                        text: agent.prompt.clone(),
                        kind: OutboxKind::Initial,
                    }
                });
            }
            agent.status = Status::Queued;
            agent.inbox_at = None;
        });
        self.schedule(now())
    }

    /// R: your own words. Answers a question, sends a finished agent back,
    /// or steers a working one.
    pub fn reply(&mut self, id: &str, text: &str) -> Vec<Effect> {
        if self.busy(id).is_some() {
            return Vec::new();
        }
        let text = text.trim();
        let Some(agent) = self.state.agent(id).cloned() else {
            return Vec::new();
        };
        if text.is_empty() {
            return Vec::new();
        }
        let live = self.is_live(id);
        match agent.status {
            Status::Question => {
                let Some(question) = agent.question.clone() else {
                    return Vec::new();
                };
                let Some(request) = question.request_id.clone().filter(|_| live) else {
                    return self.answer_later(id, &question.text, text);
                };
                let line = match question.kind {
                    QuestionKind::AskChoices => {
                        self.rt(id).other_text = Some(text.to_string());
                        rpc::ui_value(&request, OTHER)
                    }
                    QuestionKind::FreeText => rpc::ui_value(&request, text),
                    QuestionKind::Select | QuestionKind::Confirm => {
                        // These dialogs take no free text: dismiss it and steer.
                        self.resume_working(id);
                        let prompt = self.request_id("prompt");
                        return vec![
                            Effect::Send {
                                agent: id.to_string(),
                                line: rpc::ui_cancel(&request),
                            },
                            Effect::Send {
                                agent: id.to_string(),
                                line: rpc::prompt(&prompt, text, Some("steer")),
                            },
                        ];
                    }
                };
                self.resume_working(id);
                vec![Effect::Send {
                    agent: id.to_string(),
                    line,
                }]
            }
            Status::Working if live => {
                let prompt = self.request_id("prompt");
                let streaming = self
                    .runtime
                    .get(id)
                    .is_some_and(|runtime| runtime.streaming);
                vec![Effect::Send {
                    agent: id.to_string(),
                    line: rpc::prompt(&prompt, text, streaming.then_some("steer")),
                }]
            }
            Status::Queued => {
                self.edit(id, |agent| {
                    agent.outbox = Some(match agent.outbox.take() {
                        Some(outbox) => Outbox {
                            text: format!("{}\n\n{text}", outbox.text),
                            kind: outbox.kind,
                        },
                        None => Outbox {
                            text: text.to_string(),
                            kind: OutboxKind::Reply,
                        },
                    });
                });
                Vec::new()
            }
            Status::Review | Status::Failed { .. } => {
                self.edit(id, |agent| {
                    agent.outbox = Some(Outbox {
                        text: text.to_string(),
                        kind: OutboxKind::Reply,
                    });
                    agent.status = Status::Queued;
                    agent.summary = None;
                    agent.inbox_at = None;
                });
                self.schedule(now())
            }
            _ => Vec::new(),
        }
    }

    /// The program used by task processes and model discovery.
    pub fn pi_program(&self) -> &str {
        &self.pi_program
    }

    pub fn configuring(&self, id: &str) -> bool {
        self.runtime
            .get(id)
            .is_some_and(|runtime| runtime.configuring.is_some() || runtime.starting.is_some())
    }

    /// Change only the session configuration. Never abort, restart, or send a
    /// prompt: Pi applies it to the next model request, including after tools.
    pub fn configure(&mut self, id: &str, settings: SessionSettings) -> Vec<Effect> {
        let Some(agent) = self.state.agent(id) else {
            return Vec::new();
        };
        if agent.status.is_done() || self.configuring(id) || agent.session_settings == settings {
            return Vec::new();
        }
        let previous = agent.session_settings.clone();
        self.edit(id, |agent| {
            agent.session_settings = settings.clone();
            agent.note = None;
        });
        if !self.rt(id).live || self.rt(id).closing {
            return Vec::new();
        }
        if let Some(model) = settings
            .model
            .filter(|model| Some(model) != previous.model.as_ref())
        {
            let request = self.request_id("model");
            self.rt(id).configuring = Some((request.clone(), previous));
            vec![Effect::Send {
                agent: id.into(),
                line: rpc::set_model(&request, &model.provider, &model.id),
            }]
        } else {
            self.send_effort(id, previous)
        }
    }

    fn send_effort(&mut self, id: &str, previous: SessionSettings) -> Vec<Effect> {
        let level = self
            .state
            .agent(id)
            .and_then(|agent| agent.session_settings.effort.clone());
        let request = self.request_id(if level.is_some() {
            "effort"
        } else {
            "settings"
        });
        self.rt(id).configuring = Some((request.clone(), previous));
        let line = match level {
            Some(level) => rpc::set_effort(&request, &level),
            None => rpc::command(&request, "get_state"),
        };
        vec![Effect::Send {
            agent: id.into(),
            line,
        }]
    }

    fn finish_configuration(&mut self, id: &str) -> Vec<Effect> {
        match self.rt(id).deferred_idle.take() {
            Some(error) => self.check_idle(id, error),
            None => Vec::new(),
        }
    }

    fn capture_settings(&mut self, id: &str, data: &Value) {
        let settings = SessionSettings::from_state(data);
        // Older Pi versions and test fixtures may not report these fields.
        if settings.model.is_some()
            && self
                .state
                .agent(id)
                .is_some_and(|agent| agent.session_settings != settings)
        {
            self.edit(id, |agent| agent.session_settings = settings);
        }
    }

    pub fn snooze(&mut self, id: &str, until: Option<Timestamp>) {
        if let Some(agent) = self.state.agent(id) {
            self.undo.push(Undo::Snooze {
                agent: id.into(),
                until: agent.snooze_until,
            });
            if self.undo.len() > 50 {
                self.undo.remove(0);
            }
            self.edit(id, |agent| agent.snooze_until = until);
        }
    }

    /// Loads a transcript for a row without a live process.
    pub fn load_transcript(&mut self, id: &str) {
        if self.transcripts.contains_key(id) {
            return;
        }
        let Some(file) = self
            .state
            .agent(id)
            .and_then(|agent| agent.session_file.clone())
        else {
            return;
        };
        if let Ok(transcript) = Transcript::from_session_file(&file) {
            self.transcripts.insert(id.to_string(), transcript);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture {
        desk: Desk,
        _dir: tempfile::TempDir,
        id: Id,
    }

    fn sent(effects: &[Effect]) -> Vec<Value> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Send { line, .. } => Some(serde_json::from_str(line).unwrap()),
                _ => None,
            })
            .collect()
    }

    fn spawned_generation(effects: &[Effect]) -> u64 {
        effects
            .iter()
            .find_map(|effect| {
                if let Effect::Spawn(spawn) = effect {
                    Some(spawn.generation)
                } else {
                    None
                }
            })
            .expect("a spawn")
    }

    /// One project and one filed task whose worktree exists, already spawned.
    fn started() -> (Fixture, u64) {
        let dir = tempfile::tempdir().unwrap();
        let mut state = State::default();
        state.projects.push(Project {
            id: "p".into(),
            name: "Repo".into(),
            path: dir.path().into(),
        });
        let mut desk = Desk::new(state, "pi", dir.path().join("worktrees"));
        let effects = desk.file(
            "p",
            "main",
            Isolation::Worktree,
            SessionSettings::default(),
            vec![Draft {
                title: "Fix".into(),
                prompt: "Fix the bug".into(),
            }],
        );
        let Effect::CreateWorktree { agent, path, .. } = &effects[0] else {
            panic!("expected a worktree")
        };
        std::fs::create_dir_all(path).unwrap();
        let id = agent.clone();
        let effects = desk.on_worktree(&id, Ok(()));
        let generation = spawned_generation(&effects);
        let Effect::Spawn(spawn) = &effects[0] else {
            panic!()
        };
        assert_eq!(
            spawn.env,
            vec![
                ("PI_ASK_USER_TIMEOUT".to_string(), "0".to_string()),
                ("PI_DESK".to_string(), "1".to_string())
            ]
        );
        assert!(spawn.args.windows(2).any(|pair| pair[0] == "--session-id"));
        let commands = sent(&effects);
        assert_eq!(commands[0]["type"], "get_state");
        assert_eq!(commands.len(), 1);
        let effects = desk.on_lines(
            &id,
            generation,
            &[json!({
                "type":"response", "id":"startup", "command":"get_state", "success":true,
                "data":{"model":{"provider":"fake","id":"reasoning"}, "thinkingLevel":"medium"}
            })
            .to_string()],
        );
        assert_eq!(sent(&effects)[0]["message"], "Fix the bug");
        assert_eq!(desk.state.agent(&id).unwrap().status, Status::Working);
        (
            Fixture {
                desk,
                _dir: dir,
                id,
            },
            generation,
        )
    }

    fn feed(f: &mut Fixture, generation: u64, records: &[Value]) -> Vec<Effect> {
        let lines: Vec<String> = records.iter().map(Value::to_string).collect();
        f.desk.on_lines(&f.id.clone(), generation, &lines)
    }

    fn confirm_idle(f: &mut Fixture, generation: u64, effects: &[Effect]) -> Vec<Effect> {
        let commands = sent(effects);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["type"], "get_state");
        feed(
            f,
            generation,
            &[json!({
                "type":"response", "command":"get_state", "id":commands[0]["id"],
                "success":true,
                "data":{"isStreaming":false,"isCompacting":false,"pendingMessageCount":0}
            })],
        )
    }

    fn ask(f: &mut Fixture, generation: u64) -> Vec<Effect> {
        feed(
            f,
            generation,
            &[
                json!({"type":"agent_start"}),
                json!({"type":"tool_execution_start","toolCallId":"c","toolName":"ask_user","args":{"question":"Which?","choices":["A","B"],"recommended":2}}),
                json!({"type":"extension_ui_request","id":"u1","method":"select","title":"Which?","options":["A","B",OTHER]}),
            ],
        )
    }

    #[test]
    fn ask_user_questions_become_cards_and_choices_answer_the_live_dialog() {
        let (mut f, generation) = started();
        ask(&mut f, generation);
        let agent = f.desk.state.agent(&f.id).unwrap();
        assert_eq!(agent.status, Status::Question);
        let question = agent.question.clone().unwrap();
        assert_eq!(
            (
                question.choices.as_slice(),
                question.recommended,
                question.kind
            ),
            (
                &["A".to_string(), "B".to_string()][..],
                Some(1),
                QuestionKind::AskChoices
            )
        );
        let id = f.id.clone();
        let effects = f.desk.approve(&id);
        assert_eq!(
            sent(&effects),
            [json!({"type":"extension_ui_response","id":"u1","value":"B"})]
        );
        assert_eq!(f.desk.state.agent(&id).unwrap().status, Status::Working);
    }

    #[test]
    fn replies_to_choice_questions_go_through_other_and_the_following_input() {
        let (mut f, generation) = started();
        ask(&mut f, generation);
        let id = f.id.clone();
        assert_eq!(
            sent(&f.desk.reply(&id, "Neither, use C")),
            [json!({"type":"extension_ui_response","id":"u1","value":OTHER})]
        );
        let effects = feed(
            &mut f,
            generation,
            &[json!({"type":"extension_ui_request","id":"u2","method":"input","title":"Which?"})],
        );
        assert_eq!(
            sent(&effects),
            [json!({"type":"extension_ui_response","id":"u2","value":"Neither, use C"})]
        );
        assert_eq!(f.desk.state.agent(&id).unwrap().status, Status::Working);
    }

    #[test]
    fn questions_outlive_the_process_and_are_answered_by_prompt() {
        let (mut f, generation) = started();
        ask(&mut f, generation);
        let id = f.id.clone();
        f.desk.on_exit(&id, generation, Some(0), "");
        let agent = f.desk.state.agent(&id).unwrap();
        assert_eq!(agent.status, Status::Question);
        assert_eq!(agent.question.as_ref().unwrap().request_id, None);
        // The answer queues and respawns in the saved session.
        let effects = f.desk.choose(&id, 0);
        let commands = sent(&effects);
        assert!(
            effects
                .iter()
                .any(|effect| matches!(effect, Effect::Spawn(_)))
        );
        assert_eq!(
            commands
                .iter()
                .map(|c| c["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["get_state"]
        );
        let new_generation = spawned_generation(&effects);
        let effects = feed(
            &mut f,
            new_generation,
            &[json!({
                "type":"response", "id":"startup", "command":"get_state", "success":true,
                "data":{"model":{"provider":"fake","id":"reasoning"}, "thinkingLevel":"medium"}
            })],
        );
        assert_eq!(sent(&effects)[0]["type"], "get_messages");
        let effects = feed(
            &mut f,
            new_generation,
            &[
                json!({"type":"response","id":"messages","command":"get_messages","success":true,"data":{"messages":[]}}),
            ],
        );
        assert_eq!(
            sent(&effects)[0]["message"],
            "Answer to your earlier question \"Which?\": A"
        );
    }

    #[test]
    fn background_naming_refreshes_the_title_while_streaming() {
        let (mut f, generation) = started();
        let effects = feed(
            &mut f,
            generation,
            &[
                json!({"type":"agent_start"}),
                json!({"type":"extension_ui_request","id":"naming","method":"setStatus",
                "statusKey":"auto-rename"}),
            ],
        );
        assert_eq!(sent(&effects)[0]["type"], "get_state");
        feed(
            &mut f,
            generation,
            &[
                json!({"type":"response","id":"state","command":"get_state","success":true,
                "data":{"sessionName":"Background title","isStreaming":true}}),
            ],
        );
        assert_eq!(f.desk.state.agent(&f.id).unwrap().title, "Background title");
    }

    #[test]
    fn session_state_syncs_the_title_and_marks_it_for_saving() {
        let (mut f, generation) = started();
        f.desk.take_dirty();
        let state = json!({"type":"response","id":"state","command":"get_state","success":true,"data":{"sessionName":"  Fix login crash  "}});
        assert!(feed(&mut f, generation, &[state.clone()]).is_empty());
        let agent = f.desk.state.agent(&f.id).unwrap();
        assert_eq!(agent.title, "Fix login crash");
        assert_eq!(agent.prompt, "Fix the bug");
        assert!(f.desk.take_dirty());

        // An unchanged name must not count as task activity.
        feed(&mut f, generation, &[state]);
        assert!(!f.desk.take_dirty());
    }

    #[test]
    fn session_state_without_a_valid_name_preserves_the_title() {
        let (mut f, generation) = started();
        f.desk.take_dirty();
        for data in [
            json!({}),
            json!({"sessionName":null}),
            json!({"sessionName":""}),
            json!({"sessionName":" \n "}),
            json!({"sessionName":42}),
        ] {
            feed(
                &mut f,
                generation,
                &[
                    json!({"type":"response","id":"state","command":"get_state","success":true,"data":data}),
                ],
            );
            assert_eq!(f.desk.state.agent(&f.id).unwrap().title, "Fix");
            assert!(!f.desk.take_dirty());
        }
        feed(
            &mut f,
            generation,
            &[
                json!({"type":"response","id":"state","command":"get_state","success":false,"data":{"sessionName":"Ignored"},"error":"Unavailable"}),
            ],
        );
        assert_eq!(f.desk.state.agent(&f.id).unwrap().title, "Fix");
        assert!(!f.desk.take_dirty());
    }

    #[test]
    fn a_settled_run_becomes_a_review_card_with_its_summary_and_closes_the_process() {
        let (mut f, generation) = started();
        let effects = feed(
            &mut f,
            generation,
            &[
                json!({"type":"agent_start"}),
                json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
                json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"All set.\nDid: Fixed the bug.\nNeeds: Review and merge"}],"stopReason":"stop"}}),
                json!({"type":"agent_settled","aborted":false}),
            ],
        );
        assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Working);
        let effects = confirm_idle(&mut f, generation, &effects);
        assert!(effects.contains(&Effect::Close {
            agent: f.id.clone()
        }));
        let agent = f.desk.state.agent(&f.id).unwrap();
        assert_eq!(agent.status, Status::Review);
        // An idle response without sessionName preserves the existing title.
        assert_eq!(agent.title, "Fix");
        assert_eq!(
            agent.summary,
            Some(Summary {
                did: "Fixed the bug.".into(),
                needs: "Review and merge".into()
            })
        );
        assert!(agent.in_inbox(now()));
        // The expected exit after closing is not a failure.
        let id = f.id.clone();
        f.desk.on_exit(&id, generation, Some(0), "");
        assert_eq!(f.desk.state.agent(&id).unwrap().status, Status::Review);
    }

    #[test]
    fn compaction_keeps_working_through_abort_and_continuation() {
        let (mut f, generation) = started();
        // Native compact() aborts first. The events may arrive in separate reads.
        let effects = feed(
            &mut f,
            generation,
            &[json!({"type":"agent_settled","aborted":true})],
        );
        let stale_check = sent(&effects)[0]["id"].clone();
        assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Working);
        assert!(
            feed(
                &mut f,
                generation,
                &[
                    json!({"type":"compaction_start","reason":"manual"}),
                    json!({"type":"response","id":stale_check,"command":"get_state","success":true,
                "data":{"isStreaming":false,"isCompacting":false,"pendingMessageCount":0}}),
                ]
            )
            .is_empty()
        );
        assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Working);
        let effects = feed(
            &mut f,
            generation,
            &[
                json!({"type":"compaction_end","reason":"manual","aborted":false,"willRetry":false,"result":{}}),
            ],
        );
        let stale_check = sent(&effects)[0]["id"].clone();
        assert!(
            feed(
                &mut f,
                generation,
                &[
                    json!({"type":"agent_start"}),
                    json!({"type":"response","id":stale_check,"command":"get_state","success":true,
                "data":{"isStreaming":false,"isCompacting":false,"pendingMessageCount":0}}),
                ]
            )
            .is_empty()
        );
        assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Working);
        let notes: Vec<_> = f.desk.transcripts[&f.id]
            .entries
            .iter()
            .filter_map(|entry| {
                if let crate::transcript::Entry::Note { text } = entry {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(notes, ["Compacting context", "Context compacted"]);
        let effects = feed(
            &mut f,
            generation,
            &[
                json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
                json!({"type":"message_end","message":{"role":"assistant","content":"Did: Finished after compaction.\nNeeds: Review and merge","stopReason":"stop"}}),
                json!({"type":"agent_settled","aborted":false}),
            ],
        );
        let effects = confirm_idle(&mut f, generation, &effects);
        assert!(effects.contains(&Effect::Close {
            agent: f.id.clone()
        }));
        let agent = f.desk.state.agent(&f.id).unwrap();
        assert_eq!(agent.status, Status::Review);
        assert_eq!(
            agent.summary.as_ref().unwrap().did,
            "Finished after compaction."
        );
    }

    #[test]
    fn busy_state_snapshots_do_not_finish_the_task() {
        for data in [
            json!({"isStreaming":false,"isCompacting":true,"pendingMessageCount":0}),
            json!({"isStreaming":true,"isCompacting":false,"pendingMessageCount":0}),
            json!({"isStreaming":false,"isCompacting":false,"pendingMessageCount":1}),
        ] {
            let (mut f, generation) = started();
            let effects = feed(
                &mut f,
                generation,
                &[json!({"type":"agent_settled","aborted":true})],
            );
            let request = sent(&effects)[0]["id"].clone();
            assert!(feed(&mut f, generation, &[
                json!({"type":"response","id":request,"command":"get_state","success":true,"data":data}),
            ]).is_empty());
            assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Working);
        }
    }

    #[test]
    fn automatic_compaction_and_repeated_compaction_do_not_close_the_process() {
        let (mut f, generation) = started();
        for reason in ["threshold", "overflow"] {
            assert!(
                feed(
                    &mut f,
                    generation,
                    &[
                        json!({"type":"compaction_start","reason":reason}),
                        json!({"type":"agent_settled","aborted":false}),
                    ]
                )
                .is_empty()
            );
            let effects = feed(
                &mut f,
                generation,
                &[
                    json!({"type":"compaction_end","reason":reason,"aborted":false,"willRetry":true,"result":{}}),
                ],
            );
            let request = sent(&effects)[0]["id"].clone();
            assert!(
                feed(
                    &mut f,
                    generation,
                    &[
                        json!({"type":"response","id":request,"command":"get_state","success":true,
                    "data":{"isStreaming":true,"isCompacting":false,"pendingMessageCount":0}}),
                    ]
                )
                .is_empty()
            );
            assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Working);
        }
        let effects = feed(
            &mut f,
            generation,
            &[json!({"type":"agent_settled","aborted":false})],
        );
        confirm_idle(&mut f, generation, &effects);
        assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Review);
    }

    #[test]
    fn compaction_without_a_continuation_finishes_only_after_confirming_idle() {
        let (mut f, generation) = started();
        feed(
            &mut f,
            generation,
            &[json!({"type":"compaction_start","reason":"manual"})],
        );
        let effects = feed(
            &mut f,
            generation,
            &[json!({"type":"compaction_end","aborted":false,"willRetry":false,"result":{}})],
        );
        assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Working);
        confirm_idle(&mut f, generation, &effects);
        assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Review);
    }

    #[test]
    fn a_continuation_can_recover_from_failed_compaction() {
        let (mut f, generation) = started();
        let effects = feed(
            &mut f,
            generation,
            &[
                json!({"type":"compaction_start","reason":"manual"}),
                json!({"type":"compaction_end","aborted":false,"willRetry":false,"errorMessage":"Compaction failed: unavailable"}),
            ],
        );
        feed(&mut f, generation, &[json!({"type":"agent_start"})]);
        assert!(confirm_idle(&mut f, generation, &effects).is_empty());
        assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Working);
        let effects = feed(
            &mut f,
            generation,
            &[json!({"type":"agent_settled","aborted":false})],
        );
        confirm_idle(&mut f, generation, &effects);
        assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Review);
    }

    #[test]
    fn failed_idle_checks_report_an_error_instead_of_hanging() {
        let (mut f, generation) = started();
        let effects = feed(
            &mut f,
            generation,
            &[json!({"type":"agent_settled","aborted":false})],
        );
        let request = sent(&effects)[0]["id"].clone();
        feed(
            &mut f,
            generation,
            &[
                json!({"type":"response","id":request,"command":"get_state","success":false,"error":"State unavailable"}),
            ],
        );
        assert_eq!(
            f.desk.state.agent(&f.id).unwrap().status,
            Status::Failed {
                error: "State unavailable".into()
            }
        );
    }

    #[test]
    fn real_cancellations_compaction_failures_and_model_errors_still_fail() {
        for records in [
            vec![json!({"type":"agent_settled","aborted":true})],
            vec![
                json!({"type":"compaction_start","reason":"manual"}),
                json!({"type":"compaction_end","aborted":true,"willRetry":false}),
            ],
            vec![
                json!({"type":"compaction_start","reason":"manual"}),
                json!({"type":"compaction_end","aborted":false,"willRetry":false,"errorMessage":"Compaction failed: unavailable"}),
            ],
            vec![
                json!({"type":"message_start","message":{"role":"assistant","content":[]}}),
                json!({"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"Model unavailable"}}),
                json!({"type":"agent_settled","aborted":false}),
            ],
        ] {
            let (mut f, generation) = started();
            let effects = feed(&mut f, generation, &records);
            let effects = confirm_idle(&mut f, generation, &effects);
            assert!(effects.contains(&Effect::Close {
                agent: f.id.clone()
            }));
            assert!(matches!(
                f.desk.state.agent(&f.id).unwrap().status,
                Status::Failed { .. }
            ));
        }
    }

    #[test]
    fn settlement_syncs_the_name_without_requiring_one() {
        for name in [None, Some("Fix login crash")] {
            let (mut f, generation) = started();
            let effects = feed(
                &mut f,
                generation,
                &[json!({"type":"agent_settled","aborted":false})],
            );
            let request = sent(&effects)[0]["id"].clone();
            let effects = feed(
                &mut f,
                generation,
                &[json!({
                    "type":"response", "id":request, "command":"get_state", "success":true,
                    "data":{"sessionName":name,"isStreaming":false,"isCompacting":false,"pendingMessageCount":0}
                })],
            );
            assert!(effects.contains(&Effect::Close {
                agent: f.id.clone()
            }));
            let agent = f.desk.state.agent(&f.id).unwrap();
            assert_eq!(agent.status, Status::Review);
            assert_eq!(agent.title, name.unwrap_or("Fix"));
        }
    }

    #[test]
    fn a_settled_question_keeps_its_card_while_syncing_the_name() {
        for success in [true, false] {
            let (mut f, generation) = started();
            ask(&mut f, generation);
            let question = f.desk.state.agent(&f.id).unwrap().question.clone();
            let effects = feed(
                &mut f,
                generation,
                &[json!({"type":"agent_settled","aborted":false})],
            );
            let request = sent(&effects)[0]["id"].clone();
            let effects = feed(
                &mut f,
                generation,
                &[json!({
                    "type":"response", "id":request, "command":"get_state", "success":success,
                    "error":"Unavailable", "data":{"sessionName":"Fix login crash"}
                })],
            );
            assert!(effects.is_empty());
            let agent = f.desk.state.agent(&f.id).unwrap();
            assert_eq!(agent.title, if success { "Fix login crash" } else { "Fix" });
            assert_eq!(agent.status, Status::Question);
            assert_eq!(agent.question, question);
        }
    }

    #[test]
    fn unexpected_exits_and_model_errors_fail_the_row() {
        let (mut f, generation) = started();
        let id = f.id.clone();
        f.desk.on_exit(&id, generation, Some(1), "boom\nstack");
        assert!(
            matches!(&f.desk.state.agent(&id).unwrap().status, Status::Failed { error } if error.contains("stack"))
        );
        let effects = f.desk.approve(&id);
        assert!(
            effects
                .iter()
                .any(|effect| matches!(effect, Effect::Spawn(_)))
        );
        assert_eq!(sent(&effects).len(), 1);
        assert_eq!(sent(&effects)[0]["type"], "get_state");
    }

    #[test]
    fn stale_generations_are_ignored() {
        let (mut f, generation) = started();
        let id = f.id.clone();
        assert!(f.desk.on_exit(&id, generation + 7, Some(1), "").is_empty());
        assert_eq!(f.desk.state.agent(&id).unwrap().status, Status::Working);
    }

    #[test]
    fn approving_a_review_merges_and_conflicts_send_it_back() {
        let (mut f, _) = started();
        let id = f.id.clone();
        f.desk.state.agent_mut(&id).unwrap().status = Status::Review;
        f.desk.state.agent_mut(&id).unwrap().summary = Some(Summary {
            did: "Fixed it.".into(),
            needs: String::new(),
        });
        f.desk.rt(&id).live = false;
        let effects = f.desk.approve(&id);
        assert!(
            matches!(&effects[0], Effect::GenerateCommitMessage { title, summary, base, .. }
                if title == "Fix" && summary == "Fixed it." && base == "main")
        );
        assert_eq!(f.desk.busy(&id), Some("Writing commit message"));
        assert!(f.desk.approve(&id).is_empty());
        assert!(f.desk.reply(&id, "Change the task").is_empty());
        assert!(f.desk.retry(&id).is_empty());
        assert!(f.desk.discard(&id).is_empty());
        assert!(f.desk.mark_done(&id).is_empty());
        assert_eq!(f.desk.state.agent(&id).unwrap().status, Status::Review);
        let effects = f
            .desk
            .on_commit_message(&id, Ok(Some("Fix the actual bug".into())));
        assert!(
            matches!(&effects[0], Effect::Merge { message, .. } if message == "Fix the actual bug")
        );
        assert_eq!(f.desk.busy(&id), Some("Merging"));
        assert!(f.desk.approve(&id).is_empty());
        f.desk.on_merged(
            &id,
            Ok(Merge::Conflict {
                files: vec!["src/a.rs".into()],
            }),
        );
        let agent = f.desk.state.agent(&id).unwrap();
        assert!(agent.note.as_deref().unwrap().contains("src/a.rs"));
        assert!(matches!(agent.status, Status::Working | Status::Queued));
    }

    fn file_main(titles: &[&str]) -> (Desk, tempfile::TempDir, Vec<Effect>) {
        let dir = tempfile::tempdir().unwrap();
        let mut state = State::default();
        state.projects.push(Project {
            id: "p".into(),
            name: "Repo".into(),
            path: dir.path().into(),
        });
        let mut desk = Desk::new(state, "pi", dir.path().join("worktrees"));
        let drafts = titles
            .iter()
            .map(|title| Draft {
                title: title.to_string(),
                prompt: title.to_string(),
            })
            .collect();
        let effects = desk.file(
            "p",
            "main",
            Isolation::Main {
                start: "abc123".into(),
            },
            SessionSettings::default(),
            drafts,
        );
        (desk, dir, effects)
    }

    #[test]
    fn main_checkout_tasks_run_in_the_project_one_at_a_time() {
        let (mut desk, dir, effects) = file_main(&["First", "Second"]);
        assert!(
            !effects
                .iter()
                .any(|effect| matches!(effect, Effect::CreateWorktree { .. }))
        );
        let spawns: Vec<&Spawn> = effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::Spawn(spawn) => Some(spawn),
                _ => None,
            })
            .collect();
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].cwd, dir.path());
        let prompt = spawns[0]
            .args
            .windows(2)
            .find(|pair| pair[0] == "--append-system-prompt")
            .map(|pair| pair[1].clone())
            .unwrap();
        assert!(prompt.contains("the user's own checkout"));
        let (first, second) = (
            desk.state.agents[0].id.clone(),
            desk.state.agents[1].id.clone(),
        );
        assert_eq!(desk.state.agent(&second).unwrap().status, Status::Queued);

        // Discard stops the agent, leaves files alone, and frees the checkout.
        let effects = desk.discard(&first);
        assert!(
            effects
                .iter()
                .any(|effect| matches!(effect, Effect::Kill { .. }))
        );
        assert!(
            !effects
                .iter()
                .any(|effect| matches!(effect, Effect::Remove { .. }))
        );
        assert_eq!(
            desk.state.agent(&first).unwrap().status,
            Status::Done {
                outcome: Outcome::Discarded
            }
        );
        assert!(
            effects
                .iter()
                .any(|effect| matches!(effect, Effect::Spawn(spawn) if spawn.agent == second))
        );
    }

    #[test]
    fn approving_a_main_checkout_task_commits_on_its_branch() {
        let (mut desk, dir, _) = file_main(&["Fix"]);
        let id = desk.state.agents[0].id.clone();
        desk.state.agent_mut(&id).unwrap().status = Status::Review;
        desk.rt(&id).live = false;
        let effects = desk.approve(&id);
        assert!(
            matches!(&effects[0], Effect::GenerateCommitMessage { worktree, base, .. }
            if worktree == dir.path() && base == "abc123")
        );
        let effects = desk.on_commit_message(&id, Ok(Some("Fix it".into())));
        assert_eq!(
            effects,
            [Effect::Commit {
                agent: id.clone(),
                checkout: dir.path().into(),
                base: "main".into(),
                message: "Fix it".into(),
            }]
        );
        assert_eq!(desk.busy(&id), Some("Committing"));
        let effects = desk.on_merged(
            &id,
            Ok(Merge::Merged {
                commit: "def".into(),
            }),
        );
        assert!(
            !effects
                .iter()
                .any(|effect| matches!(effect, Effect::Remove { .. }))
        );
        assert_eq!(
            desk.state.agent(&id).unwrap().status,
            Status::Done {
                outcome: Outcome::Merged
            }
        );
    }

    #[test]
    fn saved_agents_without_a_workspace_kind_load_as_worktrees() {
        let (desk, _dir, _) = file_main(&["Fix"]);
        let mut value = serde_json::to_value(&desk.state.agents[0]).unwrap();
        let main: Agent = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(main, desk.state.agents[0]);
        let object = value.as_object_mut().unwrap();
        object.remove("checkout");
        object.remove("start");
        object.insert("worktree".into(), json!("/tmp/w"));
        object.insert("branch".into(), json!("pi-desk/fix"));
        let legacy: Agent = serde_json::from_value(value).unwrap();
        assert_eq!(
            legacy.workspace,
            Workspace::Worktree {
                worktree: "/tmp/w".into(),
                branch: "pi-desk/fix".into(),
            }
        );
    }

    #[test]
    fn failed_commit_messages_stay_in_review_and_can_be_retried() {
        let (mut f, _) = started();
        let id = f.id.clone();
        f.desk.state.agent_mut(&id).unwrap().status = Status::Review;
        f.desk.rt(&id).live = false;
        f.desk.approve(&id);
        assert!(
            f.desk
                .on_commit_message(&id, Err("offline".into()))
                .is_empty()
        );
        assert_eq!(f.desk.busy(&id), None);
        let agent = f.desk.state.agent(&id).unwrap();
        assert_eq!(agent.status, Status::Review);
        assert!(agent.note.as_deref().unwrap().contains("offline"));
        let effects = f.desk.approve(&id);
        assert!(matches!(&effects[0], Effect::GenerateCommitMessage { .. }));
        assert!(f.desk.state.agent(&id).unwrap().note.is_none());
    }

    #[test]
    fn stale_commit_message_results_do_not_merge() {
        let (mut f, _) = started();
        let id = f.id.clone();
        assert!(
            f.desk
                .on_commit_message(&id, Ok(Some("Stale".into())))
                .is_empty()
        );
        f.desk.state.agent_mut(&id).unwrap().status = Status::Review;
        f.desk.approve(&id);
        f.desk.state.agent_mut(&id).unwrap().status = Status::Queued;
        assert!(
            f.desk
                .on_commit_message(&id, Ok(Some("Stale".into())))
                .is_empty()
        );
        assert_eq!(f.desk.busy(&id), None);
    }

    #[test]
    fn empty_changes_need_no_commit_message_or_merge() {
        let (mut f, _) = started();
        let id = f.id.clone();
        f.desk.state.agent_mut(&id).unwrap().status = Status::Review;
        f.desk.rt(&id).live = false;
        f.desk.approve(&id);
        let effects = f.desk.on_commit_message(&id, Ok(None));
        assert!(matches!(
            &effects[0],
            Effect::Remove {
                outcome: Outcome::Merged,
                ..
            }
        ));
    }

    #[test]
    fn merged_rows_are_cleaned_up_and_done() {
        let (mut f, _) = started();
        let id = f.id.clone();
        f.desk.rt(&id).live = false;
        let effects = f.desk.on_merged(
            &id,
            Ok(Merge::Merged {
                commit: "abc".into(),
            }),
        );
        assert!(matches!(
            &effects[0],
            Effect::Remove {
                keep_branch: false,
                outcome: Outcome::Merged,
                ..
            }
        ));
        f.desk.on_removed(&id, Outcome::Merged, Ok(()));
        assert_eq!(
            f.desk.state.agent(&id).unwrap().status,
            Status::Done {
                outcome: Outcome::Merged
            }
        );
    }

    fn selection(model: &str, effort: &str) -> SessionSettings {
        SessionSettings {
            model: Some(ModelChoice {
                provider: "fake".into(),
                id: model.into(),
            }),
            effort: Some(effort.into()),
        }
    }

    fn acknowledge(
        f: &mut Fixture,
        generation: u64,
        effects: &[Effect],
        data: Value,
    ) -> Vec<Effect> {
        let commands = sent(effects);
        assert_eq!(commands.len(), 1);
        feed(
            f,
            generation,
            &[json!({
                "type":"response", "command":commands[0]["type"],
                "id":commands[0]["id"], "success":true, "data":data
            })],
        )
    }

    #[test]
    fn live_settings_are_sequenced_without_interrupting_work_or_losing_settlement() {
        let (mut f, generation) = started();
        feed(
            &mut f,
            generation,
            &[json!({
                "type":"response", "id":"state", "command":"get_state", "success":true,
                "data":{"model":{"provider":"fake","id":"plain"},"thinkingLevel":"off"}
            })],
        );
        let chosen = selection("reasoning", "max");
        let transcript_len = f.desk.transcripts[&f.id].entries.len();
        let effects = f.desk.configure(&f.id, chosen.clone());
        assert_eq!(effects.len(), 1);
        assert_eq!(sent(&effects)[0]["type"], "set_model");
        assert!(f.desk.configuring(&f.id));
        assert!(
            f.desk
                .configure(&f.id, selection("plain", "off"))
                .is_empty()
        );
        // The run ends during the settings exchange. Don't close it until its
        // new settings have been confirmed.
        assert!(
            feed(
                &mut f,
                generation,
                &[json!({"type":"agent_settled","aborted":false})]
            )
            .is_empty()
        );
        let effects = acknowledge(&mut f, generation, &effects, json!({}));
        assert_eq!(sent(&effects)[0]["type"], "set_thinking_level");
        assert_eq!(sent(&effects)[0]["level"], "max");
        let effects = acknowledge(&mut f, generation, &effects, json!({}));
        assert_eq!(sent(&effects)[0]["type"], "get_state");
        let effects = acknowledge(
            &mut f,
            generation,
            &effects,
            json!({
                "model":{"provider":"fake","id":"reasoning"}, "thinkingLevel":"max"
            }),
        );
        assert!(!f.desk.configuring(&f.id));
        assert_eq!(f.desk.state.agent(&f.id).unwrap().session_settings, chosen);
        assert_eq!(f.desk.state.agent(&f.id).unwrap().status, Status::Working);
        assert_eq!(f.desk.transcripts[&f.id].entries.len(), transcript_len);
        // Now the deferred idle confirmation can run. No prompt, abort, kill,
        // or spawn was used to change the settings.
        assert_eq!(effects.len(), 1);
        assert_eq!(sent(&effects)[0]["type"], "get_state");
    }

    #[test]
    fn snooze_undo_preserves_new_session_settings() {
        let (mut f, _) = started();
        f.desk.snooze(&f.id, Some(now() + 60));
        let chosen = selection("reasoning", "max");
        f.desk.configure(&f.id, chosen.clone());
        assert!(f.desk.undo());
        assert_eq!(f.desk.state.agent(&f.id).unwrap().session_settings, chosen);
        assert_eq!(f.desk.state.agent(&f.id).unwrap().snooze_until, None);
    }

    #[test]
    fn rejected_settings_restore_the_confirmed_selection_without_failing_the_task() {
        let (mut f, generation) = started();
        let previous = selection("reasoning", "medium");
        f.desk.state.agent_mut(&f.id).unwrap().session_settings = previous.clone();
        let effects = f.desk.configure(&f.id, selection("missing", "high"));
        let request = sent(&effects)[0]["id"].clone();
        assert!(feed(&mut f, generation + 1, &[json!({
            "type":"response","id":request,"command":"set_model","success":false,"error":"Unavailable"
        })]).is_empty());
        assert!(f.desk.configuring(&f.id));
        let effects = feed(
            &mut f,
            generation,
            &[json!({
                "type":"response","id":request,"command":"set_model","success":false,"error":"Unavailable"
            })],
        );
        assert!(!f.desk.configuring(&f.id));
        let agent = f.desk.state.agent(&f.id).unwrap();
        assert_eq!(agent.session_settings, previous);
        assert_eq!(agent.status, Status::Working);
        assert_eq!(agent.note.as_deref(), Some("Unavailable"));
        assert_eq!(sent(&effects)[0]["type"], "get_state");
        // Same-model effort changes need only the thinking command.
        let effects = f.desk.configure(&f.id, selection("reasoning", "high"));
        assert_eq!(sent(&effects)[0]["type"], "set_thinking_level");
    }

    #[test]
    fn task_settings_survive_save_and_resume_and_legacy_priority_is_ignored() {
        let (f, _) = started();
        let mut agent = serde_json::to_value(f.desk.state.agent(&f.id).unwrap()).unwrap();
        agent.as_object_mut().unwrap().remove("session_settings");
        agent["priority"] = json!("urgent");
        let legacy: Agent = serde_json::from_value(agent).unwrap();
        assert_eq!(legacy.session_settings, SessionSettings::default());
        assert!(
            serde_json::to_value(legacy)
                .unwrap()
                .get("priority")
                .is_none()
        );

        let mut state = f.desk.state.clone();
        let agent = state.agent_mut(&f.id).unwrap();
        agent.session_settings = selection("reasoning", "max");
        agent.outbox = Some(Outbox {
            text: "Continue".into(),
            kind: OutboxKind::Reply,
        });
        let store = crate::store::Store::new(f._dir.path().join("settings-state"));
        store.save(&state).unwrap();
        let mut restarted = Desk::new(store.load().unwrap(), "pi", f._dir.path().join("worktrees"));
        let effects = restarted.schedule(now());
        let spawn = effects
            .iter()
            .find_map(|effect| match effect {
                Effect::Spawn(spawn) => Some(spawn),
                _ => None,
            })
            .unwrap();
        for pair in [
            ["--provider", "fake"],
            ["--model", "reasoning"],
            ["--thinking", "max"],
        ] {
            assert!(spawn.args.windows(2).any(|args| args == pair));
        }
        let generation = spawn.generation;
        let effects = restarted.on_lines(
            &f.id,
            generation,
            &[json!({
                "type":"response", "id":"startup", "command":"get_state", "success":true,
                "data":{"model":{"provider":"fake","id":"reasoning"}, "thinkingLevel":"max"}
            })
            .to_string()],
        );
        assert_eq!(sent(&effects)[0]["type"], "get_messages");
        assert_eq!(
            restarted.state.agent(&f.id).unwrap().session_settings,
            selection("reasoning", "max")
        );
    }

    #[test]
    fn working_agents_resume_after_a_restart() {
        let (f, _) = started();
        let state = f.desk.state.clone();
        let desk = Desk::new(state, "pi", "/tmp");
        let agent = desk.state.agent(&f.id).unwrap().clone();
        assert_eq!(agent.status, Status::Queued);
        assert_eq!(agent.outbox.unwrap().kind, OutboxKind::Resume);
    }

    #[test]
    fn slugs_are_short_and_safe() {
        assert_eq!(slug("Fix the Login — bug!", 40), "fix-the-login-bug");
        assert_eq!(slug("!!!", 40), "task");
    }
}
