//! Swarm workers started from a task's session.
//!
//! The `swarm` extension keeps each run in `<agent dir>/swarm/<run>/run.json`.
//! A run belongs to a task when its root node's `session` is the task's Pi
//! session ID.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worker {
    pub id: String,
    pub name: String,
    /// `starting`, `running`, or `review`.
    pub status: String,
    /// The worker's last reported activity, such as `working`.
    pub activity: Option<String>,
    pub model: Option<String>,
    /// Nesting below the root: 0 for the root's own children.
    pub level: usize,
}

pub fn active(status: &str) -> bool {
    matches!(status, "starting" | "running" | "review")
}

fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Active workers of one run, depth first under their parents. A worker whose
/// parent is no longer active stays at its own depth.
fn workers(run: &Value) -> Vec<Worker> {
    let Some(nodes) = run.get("nodes").and_then(Value::as_object) else {
        return Vec::new();
    };
    let Some(root) = string(run, "root") else {
        return Vec::new();
    };
    let mut children: HashMap<String, Vec<&Value>> = HashMap::new();
    for node in nodes.values() {
        if let Some(parent) = string(node, "parent") {
            children.entry(parent).or_default().push(node);
        }
    }
    for list in children.values_mut() {
        list.sort_by_key(|node| (string(node, "started"), string(node, "name")));
    }
    let mut out = Vec::new();
    let mut stack: Vec<(String, usize)> = vec![(root, 0)];
    let mut seen = HashSet::new();
    while let Some((id, level)) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let kids = children.get(&id).map(Vec::as_slice).unwrap_or_default();
        for node in kids.iter().rev() {
            if let Some(child) = string(node, "id") {
                stack.push((child, level + 1));
            }
        }
        if level == 0 {
            continue;
        }
        let Some(node) = nodes.get(&id) else { continue };
        let status = string(node, "status").unwrap_or_default();
        if !active(&status) {
            continue;
        }
        let depth = node
            .get("depth")
            .and_then(Value::as_u64)
            .map_or(level, |depth| depth as usize);
        out.push(Worker {
            id,
            name: string(node, "name").unwrap_or_else(|| "worker".into()),
            status,
            activity: node.get("activity").and_then(|a| string(a, "status")),
            model: node
                .get("current")
                .and_then(|c| string(c, "model"))
                .or_else(|| node.get("launch").and_then(|l| string(l, "model"))),
            level: depth.saturating_sub(1),
        });
    }
    out
}

/// Active workers for each of `sessions`, from every run under `dir`.
/// Unreadable runs are skipped.
pub fn scan(dir: &Path, sessions: &HashSet<String>) -> HashMap<String, Vec<Worker>> {
    let mut found: HashMap<String, Vec<Worker>> = HashMap::new();
    if sessions.is_empty() {
        return found;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    let mut runs: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
    runs.sort();
    for run in runs {
        let Ok(text) = std::fs::read_to_string(run.join("run.json")) else {
            continue;
        };
        // Skip the parse for runs that cannot match.
        if !sessions.iter().any(|session| text.contains(session.as_str())) {
            continue;
        }
        let Ok(run) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let session = string(&run, "root")
            .and_then(|root| run.get("nodes")?.get(&root).cloned())
            .and_then(|root| string(&root, "session"));
        let Some(session) = session.filter(|session| sessions.contains(session)) else {
            continue;
        };
        let active = workers(&run);
        if !active.is_empty() {
            found.entry(session).or_default().extend(active);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, parent: Option<&str>, depth: u64, status: &str) -> Value {
        let mut node = json!({
            "id": id, "name": format!("{id}-name"), "task": "t", "depth": depth,
            "status": status, "current": {"model": "m/one", "thinking": "high"},
            "activity": {"status": "working", "detail": "", "updated": "x"},
        });
        if let Some(parent) = parent {
            node["parent"] = json!(parent);
        }
        node
    }

    fn write_run(dir: &Path, id: &str, session: &str, nodes: Vec<Value>) {
        let mut map = serde_json::Map::new();
        map.insert(
            "root".into(),
            json!({"id": "root", "name": "root", "task": "t", "depth": 0, "status": "running", "session": session}),
        );
        for node in nodes {
            map.insert(node["id"].as_str().unwrap().into(), node);
        }
        let run = json!({"version": 1, "id": id, "root": "root", "objective": "o", "messages": [], "nodes": map});
        std::fs::create_dir_all(dir.join(id)).unwrap();
        std::fs::write(dir.join(id).join("run.json"), run.to_string()).unwrap();
    }

    #[test]
    fn finds_active_nested_workers_for_matching_sessions_only() {
        let dir = tempfile::tempdir().unwrap();
        write_run(
            dir.path(),
            "run-a",
            "session-a",
            vec![
                node("a", Some("root"), 1, "running"),
                node("a1", Some("a"), 2, "review"),
                node("b", Some("root"), 1, "accepted"),
                node("b1", Some("b"), 2, "starting"),
                node("c", Some("root"), 1, "failed"),
            ],
        );
        write_run(
            dir.path(),
            "run-other",
            "session-other",
            vec![node("x", Some("root"), 1, "running")],
        );
        write_run(
            dir.path(),
            "run-done",
            "session-done",
            vec![node("y", Some("root"), 1, "stopped")],
        );
        std::fs::create_dir_all(dir.path().join("broken")).unwrap();
        std::fs::write(dir.path().join("broken/run.json"), "session-a {").unwrap();

        let sessions: HashSet<String> = ["session-a", "session-done"]
            .into_iter()
            .map(String::from)
            .collect();
        let found = scan(dir.path(), &sessions);
        assert_eq!(found.len(), 1, "terminal and unrelated runs show nothing");
        let workers = &found["session-a"];
        let shape: Vec<(&str, &str, usize)> = workers
            .iter()
            .map(|w| (w.id.as_str(), w.status.as_str(), w.level))
            .collect();
        assert_eq!(
            shape,
            vec![("a", "running", 0), ("a1", "review", 1), ("b1", "starting", 1)]
        );
        assert_eq!(workers[0].name, "a-name");
        assert_eq!(workers[0].activity.as_deref(), Some("working"));
        assert_eq!(workers[0].model.as_deref(), Some("m/one"));
    }

    #[test]
    fn no_sessions_or_directory_means_no_workers() {
        let dir = tempfile::tempdir().unwrap();
        assert!(scan(dir.path(), &HashSet::new()).is_empty());
        let sessions = HashSet::from(["s".to_string()]);
        assert!(scan(&dir.path().join("missing"), &sessions).is_empty());
    }
}
