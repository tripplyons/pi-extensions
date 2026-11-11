//! Saved state under `~/.pi/agent/pi-desk` (`PI_CODING_AGENT_DIR` overrides
//! the agent directory, as it does for Pi and the swarm extension).

use crate::model::State;
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn agent_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_DIR").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".pi").join("agent")
}

#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Store { root: root.into() }
    }

    pub fn default_location() -> Self {
        Store::new(agent_dir().join("pi-desk"))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }

    pub fn worktrees(&self) -> PathBuf {
        self.root.join("worktrees")
    }

    /// A missing file is a first run. A corrupt file is an error, so the app
    /// never silently replaces saved work with an empty state.
    pub fn load(&self) -> Result<State, String> {
        match std::fs::read_to_string(self.state_file()) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|error| format!("{}: {error}", self.state_file().display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(error) => Err(format!("{}: {error}", self.state_file().display())),
        }
    }

    /// Writes a temporary file and renames it over the old state.
    pub fn save(&self, state: &State) -> Result<(), String> {
        let fail = |error: std::io::Error| format!("{}: {error}", self.state_file().display());
        std::fs::create_dir_all(&self.root).map_err(fail)?;
        let temporary = self
            .root
            .join(format!("state.json.{}.tmp", std::process::id()));
        let text = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
        let mut file = std::fs::File::create(&temporary).map_err(fail)?;
        file.write_all(&text).map_err(fail)?;
        file.sync_all().map_err(fail)?;
        std::fs::rename(&temporary, self.state_file()).map_err(fail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Project, Settings};

    #[test]
    fn missing_state_is_empty_and_saved_state_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("pi-desk"));
        assert_eq!(store.load().unwrap(), State::default());
        let state = State {
            projects: vec![Project {
                id: "p".into(),
                name: "Repo".into(),
                path: "/tmp/repo".into(),
                kind: Default::default(),
            }],
            agents: vec![],
            settings: Settings {
                slots: 2,
                ..Settings::default()
            },
        };
        store.save(&state).unwrap();
        assert_eq!(store.load().unwrap(), state);
    }

    #[test]
    fn corrupt_state_is_an_error_not_an_empty_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path());
        std::fs::write(store.state_file(), "{not json").unwrap();
        assert!(store.load().is_err());
    }
}
