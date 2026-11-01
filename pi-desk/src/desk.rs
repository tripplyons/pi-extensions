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
    ask: Option<Ask>,
    /// Free text to send when the `input` after "Other" arrives.
    other_text: Option<String>,
    preparing: bool,
    busy: Option<&'static str>,
}

#[derive(Debug, Clone)]
enum Undo {
    Agent(Box<Agent>),
    Projects(Vec<Project>),
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

    fn remember(&mut self, id: &str) {
        if let Some(agent) = self.state.agent(id) {
            self.undo.push(Undo::Agent(Box::new(agent.clone())));
            if self.undo.len() > 50 {
                self.undo.remove(0);
            }
        }
    }

    /// Reverts the latest local change (priority, snooze, project order).
    pub fn undo(&mut self) -> bool {
        let Some(undo) = self.undo.pop() else {
            return false;
        };
        match undo {
            Undo::Agent(previous) => {
                if let Some(agent) = self.state.agent_mut(&previous.id) {
                    *agent = *previous;
                }
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

    /// Files drafts as queued agents. `base` is the branch they merge into.
    pub fn file(
        &mut self,
        project_id: &str,
        base: &str,
        priority: Priority,
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
                priority,
                status: Status::Queued,
                created_at: at,
                updated_at: at,
                inbox_at: None,
                base_branch: base.to_string(),
                branch: format!("pi-desk/{name}"),
                worktree: self.worktree_root.join(slug(&project.name, 40)).join(&name),
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
            effects.push(self.prepare(&agent));
            self.state.agents.push(agent);
        }
        self.dirty = true;
        effects
    }

    fn prepare(&mut self, agent: &Agent) -> Effect {
        self.rt(&agent.id).preparing = true;
        let repo = self
            .state
            .project(&agent.project_id)
            .map(|project| project.path.clone())
            .unwrap_or_default();
        Effect::CreateWorktree {
            agent: agent.id.clone(),
            repo,
            path: agent.worktree.clone(),
            branch: agent.branch.clone(),
            base: agent.base_branch.clone(),
        }
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
            .filter(|agent| agent.status == Status::Queued && !agent.worktree.exists())
            .filter(|agent| {
                !self
                    .runtime
                    .get(&agent.id)
                    .is_some_and(|runtime| runtime.preparing)
            })
            .cloned()
            .collect();
        for agent in &missing {
            if agent.started {
                self.edit(&agent.id, |agent| {
                    agent.status = Status::Failed {
                        error: format!("The worktree at {} is missing", agent.worktree.display()),
                    };
                    agent.inbox_at = Some(now());
                });
            } else {
                effects.push(self.prepare(agent));
            }
        }
        let ready: Vec<Id> = order::to_start(&self.state, self.running(), at)
            .into_iter()
            .filter(|id| {
                self.state
                    .agent(id)
                    .is_some_and(|agent| agent.worktree.exists())
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
            args: vec![
                "--mode".into(),
                "rpc".into(),
                "--session-id".into(),
                agent.session_id.clone(),
                "--append-system-prompt".into(),
                summary::SYSTEM_PROMPT.into(),
            ],
            cwd: agent.worktree.clone(),
            env: vec![
                ("PI_ASK_USER_TIMEOUT".into(), "0".into()),
                ("PI_DESK".into(), "1".into()),
            ],
        })];
        effects.push(Effect::Send {
            agent: id.to_string(),
            line: rpc::command("state", "get_state"),
        });
        if resumed {
            // The outbox prompt goes out once the history is loaded, so live
            // events always append after it.
            effects.push(Effect::Send {
                agent: id.to_string(),
                line: rpc::command("messages", "get_messages"),
            });
        } else {
            effects.extend(self.send_outbox(id));
        }
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
                if request == "state" {
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
                } else if request == "messages" {
                    if let Some(messages) = data.get("messages").and_then(Value::as_array) {
                        self.transcripts
                            .insert(id.to_string(), Transcript::from_messages(messages.iter()));
                    }
                    return self.send_outbox(id);
                } else if request.starts_with("prompt") && !success {
                    let error = error.unwrap_or_else(|| "Pi rejected the prompt".into());
                    return self.fail(id, error);
                }
            }
            Incoming::AgentStart => self.rt(id).streaming = true,
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
            Incoming::AgentSettled { .. } => return self.settle(id),
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

    fn settle(&mut self, id: &str) -> Vec<Effect> {
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
        let error = transcript.and_then(|transcript| transcript.last_error.clone());
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
                let Some(project) = self.state.project(&agent.project_id).cloned() else {
                    return Vec::new();
                };
                self.rt(id).busy = Some("Merging");
                let did = agent
                    .summary
                    .as_ref()
                    .map(|summary| summary.did.clone())
                    .unwrap_or_default();
                let message = if did.is_empty() {
                    agent.title.clone()
                } else {
                    format!("{}\n\n{did}", agent.title)
                };
                vec![Effect::Merge {
                    agent: id.to_string(),
                    repo: project.path,
                    worktree: agent.worktree,
                    branch: agent.branch,
                    base: agent.base_branch,
                    message,
                }]
            }
            _ => Vec::new(),
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
                let list = if files.is_empty() {
                    "some files".to_string()
                } else {
                    files.join(", ")
                };
                let text = format!(
                    "Squash-merging your branch into {} conflicts in: {list}. Rebase {} onto {}, resolve the conflicts, run the checks, and commit.",
                    agent.base_branch, agent.branch, agent.base_branch
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
        self.rt(id).busy = Some("Cleaning up");
        effects.push(Effect::Remove {
            agent: id.to_string(),
            repo,
            worktree: agent.worktree,
            branch: agent.branch,
            keep_branch,
            outcome,
        });
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

    /// X: stop the agent and delete its worktree and branch.
    pub fn discard(&mut self, id: &str) -> Vec<Effect> {
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

    pub fn set_priority(&mut self, id: &str, priority: Priority) -> Vec<Effect> {
        if self
            .state
            .agent(id)
            .is_some_and(|agent| agent.priority != priority)
        {
            self.remember(id);
            self.edit(id, |agent| agent.priority = priority);
        }
        self.schedule(now())
    }

    pub fn snooze(&mut self, id: &str, until: Option<Timestamp>) {
        self.remember(id);
        self.edit(id, |agent| agent.snooze_until = until);
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
            Priority::Medium,
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
        assert_eq!(commands[1]["message"], "Fix the bug");
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
            ["get_state", "get_messages"]
        );
        let new_generation = spawned_generation(&effects);
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
        assert!(effects.contains(&Effect::Close {
            agent: f.id.clone()
        }));
        let agent = f.desk.state.agent(&f.id).unwrap();
        assert_eq!(agent.status, Status::Review);
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
        assert_eq!(sent(&effects)[1]["type"], "get_messages");
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
            matches!(&effects[0], Effect::Merge { message, base, .. } if message == "Fix\n\nFixed it." && base == "main")
        );
        assert_eq!(f.desk.busy(&id), Some("Merging"));
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

    #[test]
    fn working_agents_resume_after_a_restart_and_priority_changes_undo() {
        let (f, _) = started();
        let state = f.desk.state.clone();
        let mut desk = Desk::new(state, "pi", "/tmp");
        let agent = desk.state.agent(&f.id).unwrap().clone();
        assert_eq!(agent.status, Status::Queued);
        assert_eq!(agent.outbox.unwrap().kind, OutboxKind::Resume);
        desk.set_priority(&f.id, Priority::Urgent);
        assert_eq!(desk.state.agent(&f.id).unwrap().priority, Priority::Urgent);
        assert!(desk.undo());
        assert_eq!(desk.state.agent(&f.id).unwrap().priority, Priority::Medium);
    }

    #[test]
    fn slugs_are_short_and_safe() {
        assert_eq!(slug("Fix the Login — bug!", 40), "fix-the-login-bug");
        assert_eq!(slug("!!!", 40), "task");
    }
}
