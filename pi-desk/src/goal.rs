//! A task's goal from the `goal` extension.
//!
//! The extension appends a `pi:goal` custom entry to the session file each time
//! the goal changes, and sets the `goal` status while the goal is active. The
//! latest entry gives the objective; the live status tells an active goal from
//! one that will resume paused.

use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalStatus {
    Active,
    Paused,
    Complete,
    Blocked,
}

impl GoalStatus {
    pub fn label(self) -> &'static str {
        match self {
            GoalStatus::Active => "Active",
            GoalStatus::Paused => "Paused",
            GoalStatus::Complete => "Complete",
            GoalStatus::Blocked => "Blocked",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Goal {
    pub objective: String,
    pub status: GoalStatus,
}

/// The goal a `pi:goal` entry records, or `Some(None)` when it clears the goal.
fn entry(line: &str) -> Option<Option<Goal>> {
    if !line.contains("\"pi:goal\"") {
        return None;
    }
    let record: Value = serde_json::from_str(line).ok()?;
    if record.get("type")?.as_str()? != "custom"
        || record.get("customType")?.as_str()? != "pi:goal"
    {
        return None;
    }
    let data = record.get("data")?;
    let objective = data.get("objective").and_then(Value::as_str);
    let status = match data.get("status").and_then(Value::as_str) {
        Some("active") => GoalStatus::Active,
        Some("paused") => GoalStatus::Paused,
        Some("complete") => GoalStatus::Complete,
        Some("blocked") => GoalStatus::Blocked,
        _ => return Some(None),
    };
    Some(objective.map(|objective| Goal {
        objective: objective.trim().to_string(),
        status,
    }))
}

/// The goal to show: unfinished goals only. A saved active goal without the
/// live status belongs to a stopped process, and Pi resumes it paused.
pub fn shown(saved: Option<&Goal>, live: bool) -> Option<Goal> {
    let goal = saved?;
    let status = match goal.status {
        GoalStatus::Active | GoalStatus::Paused if live => GoalStatus::Active,
        GoalStatus::Active | GoalStatus::Paused => GoalStatus::Paused,
        GoalStatus::Complete | GoalStatus::Blocked => return None,
    };
    Some(Goal {
        objective: goal.objective.clone(),
        status,
    })
}

/// Follows one session file, reading only what was appended since the last
/// read. A file that shrinks or changes path is read again from the start.
#[derive(Debug, Default, Clone)]
pub struct Follower {
    path: Option<PathBuf>,
    offset: u64,
    goal: Option<Goal>,
}

impl Follower {
    pub fn goal(&self) -> Option<&Goal> {
        self.goal.as_ref()
    }

    pub fn read(&mut self, path: &Path) -> std::io::Result<()> {
        if self.path.as_deref() != Some(path) {
            *self = Follower {
                path: Some(path.to_path_buf()),
                ..Follower::default()
            };
        }
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            self.offset = 0;
            self.goal = None;
        }
        if len == self.offset {
            return Ok(());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.take(len - self.offset).read_to_end(&mut bytes)?;
        // Leave a partly written last line for the next read.
        let Some(end) = bytes.iter().rposition(|byte| *byte == b'\n') else {
            return Ok(());
        };
        for line in String::from_utf8_lossy(&bytes[..end]).lines() {
            if let Some(goal) = entry(line) {
                self.goal = goal;
            }
        }
        self.offset += end as u64 + 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(status: &str, objective: &str) -> String {
        format!(
            r#"{{"type":"custom","customType":"pi:goal","data":{{"objective":"{objective}","status":"{status}","createdAt":1,"elapsedMs":0,"tokens":0,"continuations":0}}}}"#
        )
    }

    #[test]
    fn the_latest_entry_wins_and_null_clears() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(file, r#"{{"type":"message","message":{{"role":"user","content":"pi:goal"}}}}"#).unwrap();
        writeln!(file, "{}", line("active", "Ship it")).unwrap();
        let mut follower = Follower::default();
        follower.read(&path).unwrap();
        assert_eq!(
            follower.goal(),
            Some(&Goal {
                objective: "Ship it".into(),
                status: GoalStatus::Active
            })
        );

        // Appended entries are read incrementally; a partial line waits.
        write!(file, "{}", line("complete", "Ship it")).unwrap();
        follower.read(&path).unwrap();
        assert_eq!(follower.goal().unwrap().status, GoalStatus::Active);
        writeln!(file).unwrap();
        follower.read(&path).unwrap();
        assert_eq!(follower.goal().unwrap().status, GoalStatus::Complete);

        writeln!(file, r#"{{"type":"custom","customType":"pi:goal","data":null}}"#).unwrap();
        follower.read(&path).unwrap();
        assert_eq!(follower.goal(), None);
    }

    #[test]
    fn a_rewritten_file_is_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, format!("{}\n{}\n", line("active", "One"), line("paused", "One"))).unwrap();
        let mut follower = Follower::default();
        follower.read(&path).unwrap();
        assert_eq!(follower.goal().unwrap().status, GoalStatus::Paused);
        std::fs::write(&path, format!("{}\n", line("active", "Two"))).unwrap();
        follower.read(&path).unwrap();
        assert_eq!(follower.goal().unwrap().objective, "Two");
    }

    #[test]
    fn only_unfinished_goals_are_shown() {
        let goal = |status| Goal {
            objective: "Ship it".into(),
            status,
        };
        let active = goal(GoalStatus::Active);
        assert_eq!(shown(Some(&active), true).unwrap().status, GoalStatus::Active);
        assert_eq!(shown(Some(&active), false).unwrap().status, GoalStatus::Paused);
        assert_eq!(
            shown(Some(&goal(GoalStatus::Paused)), false).unwrap().status,
            GoalStatus::Paused
        );
        assert_eq!(shown(Some(&goal(GoalStatus::Complete)), true), None);
        assert_eq!(shown(Some(&goal(GoalStatus::Blocked)), false), None);
        assert_eq!(shown(None, true), None);
    }
}
