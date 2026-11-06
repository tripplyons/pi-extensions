//! Projects, agents, and the settings saved between runs.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub type Id = String;

/// Seconds since the Unix epoch. Saved state uses plain integers so it stays
/// readable and comparable.
pub type Timestamp = i64;

pub fn now() -> Timestamp {
    chrono::Utc::now().timestamp()
}

pub fn new_id() -> Id {
    uuid::Uuid::now_v7().to_string()
}

/// Pi model identity. Provider is required because model IDs are not unique.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelChoice {
    pub provider: String,
    pub id: String,
}

impl std::fmt::Display for ModelChoice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.provider, self.id)
    }
}

/// None means use Pi's defaults. Concrete values belong to this task only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSettings {
    pub model: Option<ModelChoice>,
    pub effort: Option<String>,
}

impl SessionSettings {
    pub fn from_state(data: &serde_json::Value) -> Self {
        Self {
            model: data
                .get("model")
                .and_then(|model| serde_json::from_value(model.clone()).ok()),
            effort: data
                .get("thinkingLevel")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
        }
    }

    pub fn args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(model) = &self.model {
            args.extend([
                "--provider".into(),
                model.provider.clone(),
                "--model".into(),
                model.id.clone(),
            ]);
        }
        if let Some(effort) = &self.effort {
            args.extend(["--thinking".into(), effort.clone()]);
        }
        args
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: Id,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Outcome {
    Merged,
    Discarded,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Status {
    /// Waiting for a running slot. `Agent::outbox` holds the prompt to send.
    Queued,
    Working,
    /// An `ask_user` (or other extension dialog) is waiting. See `Agent::question`.
    Question,
    /// The agent finished a run and its summary is ready.
    Review,
    Failed {
        error: String,
    },
    Done {
        outcome: Outcome,
    },
}

impl Status {
    pub fn label(&self) -> &'static str {
        match self {
            Status::Queued => "Queued",
            Status::Working => "Working",
            Status::Question => "Question",
            Status::Review => "Review",
            Status::Failed { .. } => "Failed",
            Status::Done {
                outcome: Outcome::Merged,
            } => "Merged",
            Status::Done {
                outcome: Outcome::Discarded,
            } => "Discarded",
            Status::Done {
                outcome: Outcome::Closed,
            } => "Done",
        }
    }

    /// Rows that wait on the user.
    pub fn needs_user(&self) -> bool {
        matches!(
            self,
            Status::Question | Status::Review | Status::Failed { .. }
        )
    }

    pub fn is_done(&self) -> bool {
        matches!(self, Status::Done { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QuestionKind {
    /// `ask_user` with choices, answered through RPC `select`.
    /// Free text goes through its "Other" entry and the `input` that follows.
    AskChoices,
    /// `ask_user` without choices, or another extension's `input`/`editor`.
    FreeText,
    /// Another extension's `select`: choices only, no free text.
    Select,
    /// Another extension's `confirm`.
    Confirm,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    pub text: String,
    pub choices: Vec<String>,
    /// 0-based index into `choices`.
    pub recommended: Option<usize>,
    pub kind: QuestionKind,
    /// The live RPC dialog id. `None` after a restart or timeout, when the
    /// answer goes to the agent as a follow-up prompt instead.
    #[serde(skip)]
    pub request_id: Option<String>,
    pub asked_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    pub did: String,
    pub needs: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OutboxKind {
    Initial,
    Reply,
    Answer,
    Resume,
}

/// A prompt waiting for the agent's next process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outbox {
    pub text: String,
    pub kind: OutboxKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Agent {
    pub id: Id,
    pub project_id: Id,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub session_settings: SessionSettings,
    pub status: Status,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// The branch the work lands on.
    pub base_branch: String,
    #[serde(flatten)]
    pub workspace: Workspace,
    pub session_id: String,
    pub session_file: Option<PathBuf>,
    pub summary: Option<Summary>,
    pub question: Option<Question>,
    pub outbox: Option<Outbox>,
    pub snooze_until: Option<Timestamp>,
    /// A short app-written note, such as a merge conflict.
    pub note: Option<String>,
    /// True once a Pi process has run for this agent, so its session exists.
    pub started: bool,
}

/// Where an agent works. Untagged so state saved before the main-checkout
/// option still loads as a worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Workspace {
    /// A dedicated worktree on its own branch, squash-merged into the base.
    Worktree { worktree: PathBuf, branch: String },
    /// The project's own checkout. `start` is the commit HEAD named at filing;
    /// the task's diff is everything since then.
    Main { checkout: PathBuf, start: String },
}

impl Workspace {
    pub fn path(&self) -> &Path {
        match self {
            Workspace::Worktree { worktree, .. } => worktree,
            Workspace::Main { checkout, .. } => checkout,
        }
    }

    pub fn is_main(&self) -> bool {
        matches!(self, Workspace::Main { .. })
    }
}

impl Agent {
    /// The revision the task's diff is measured from.
    pub fn diff_base(&self) -> &str {
        match &self.workspace {
            Workspace::Worktree { .. } => &self.base_branch,
            Workspace::Main { start, .. } => start,
        }
    }

    pub fn snoozed(&self, at: Timestamp) -> bool {
        self.snooze_until.is_some_and(|until| until > at)
    }

    pub fn in_inbox(&self, at: Timestamp) -> bool {
        self.status.needs_user() && !self.snoozed(at)
    }

    pub fn touch(&mut self) {
        self.updated_at = now();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Most agents that may work at once.
    pub slots: usize,
    /// Shell command templates. `{path}` becomes the quoted task checkout path.
    pub terminal_command: String,
    pub editor_command: String,
    /// Vim-style modal editing in the reply and task boxes.
    pub vim_mode: bool,
    /// Keys typed quickly in insert mode that act as Escape. Empty turns this off.
    pub vim_escape: String,
}

impl Default for Settings {
    fn default() -> Self {
        let ghostty = std::path::Path::new("/Applications/Ghostty.app").exists();
        let editor = std::env::var("EDITOR").unwrap_or_else(|_| "vi".into());
        Settings {
            slots: 4,
            vim_mode: true,
            vim_escape: "jk".into(),
            terminal_command: if ghostty {
                "open -a Ghostty {path}".into()
            } else {
                "open -a Terminal {path}".into()
            },
            editor_command: if ghostty {
                format!("open -na Ghostty --args --working-directory={{path}} -e {editor} .")
            } else {
                "open {path}".into()
            },
        }
    }
}

/// Everything saved in `state.json`. Project order is rank order.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub projects: Vec<Project>,
    pub agents: Vec<Agent>,
    pub settings: Settings,
}

impl State {
    pub fn project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|project| project.id == id)
    }

    pub fn project_rank(&self, id: &str) -> usize {
        self.projects
            .iter()
            .position(|project| project.id == id)
            .unwrap_or(usize::MAX)
    }

    pub fn agent(&self, id: &str) -> Option<&Agent> {
        self.agents.iter().find(|agent| agent.id == id)
    }

    pub fn agent_mut(&mut self, id: &str) -> Option<&mut Agent> {
        self.agents.iter_mut().find(|agent| agent.id == id)
    }
}
