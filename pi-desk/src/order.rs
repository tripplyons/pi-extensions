//! Display order is status, then most recent activity. Scheduling is separate:
//! Project order, then replies before new work, then oldest queued task.

use crate::model::{Agent, OutboxKind, State, Status, Timestamp};
use std::cmp::Ordering;
use std::collections::HashMap;

/// Shared list groups and board columns, in display order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DisplayGroup {
    NeedsYou,
    Working,
    Queued,
    Later,
    Done,
}

impl DisplayGroup {
    pub const ALL: [Self; 5] = [
        Self::NeedsYou,
        Self::Working,
        Self::Queued,
        Self::Later,
        Self::Done,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::NeedsYou => "Needs you",
            Self::Working => "Working",
            Self::Queued => "Queued",
            Self::Later => "Later",
            Self::Done => "Done",
        }
    }
}

pub fn display_group(agent: &Agent, at: Timestamp) -> DisplayGroup {
    match agent.status {
        Status::Done { .. } => DisplayGroup::Done,
        _ if agent.snoozed(at) => DisplayGroup::Later,
        Status::Question | Status::Review | Status::Failed { .. } => DisplayGroup::NeedsYou,
        Status::Working => DisplayGroup::Working,
        Status::Queued => DisplayGroup::Queued,
    }
}

pub fn compare_display(a: &Agent, b: &Agent, at: Timestamp) -> Ordering {
    display_group(a, at)
        .cmp(&display_group(b, at))
        .then(b.updated_at.cmp(&a.updated_at))
        .then(b.created_at.cmp(&a.created_at))
        .then(a.id.cmp(&b.id))
}

pub fn compare_queue(state: &State, a: &Agent, b: &Agent) -> Ordering {
    let new_work = |agent: &Agent| {
        matches!(
            agent.outbox.as_ref().map(|outbox| outbox.kind),
            Some(OutboxKind::Initial) | None
        )
    };
    state
        .project_rank(&a.project_id)
        .cmp(&state.project_rank(&b.project_id))
        .then(new_work(a).cmp(&new_work(b)))
        .then(a.created_at.cmp(&b.created_at))
}

/// Inbox rows in display order, newest activity first.
pub fn inbox<'a>(state: &'a State, at: Timestamp) -> Vec<&'a Agent> {
    let mut rows: Vec<&Agent> = state
        .agents
        .iter()
        .filter(|agent| agent.in_inbox(at))
        .collect();
    rows.sort_by(|a, b| compare_display(a, b, at));
    rows
}

/// Queued agents to start now, given how many are running. A project's main
/// checkout holds one task at a time: from its first start until it is done.
pub fn to_start(state: &State, running: usize, at: Timestamp) -> Vec<String> {
    let free = state.settings.slots.max(1).saturating_sub(running);
    let mut holders: HashMap<&str, &str> = state
        .agents
        .iter()
        .filter(|agent| agent.workspace.is_main() && agent.started && !agent.status.is_done())
        .map(|agent| (agent.project_id.as_str(), agent.id.as_str()))
        .collect();
    let mut queued: Vec<&Agent> = state
        .agents
        .iter()
        .filter(|agent| agent.status == Status::Queued && !agent.snoozed(at))
        .collect();
    queued.sort_by(|a, b| compare_queue(state, a, b));
    queued
        .into_iter()
        .filter(|agent| {
            if !agent.workspace.is_main() {
                return true;
            }
            let holder = holders
                .entry(agent.project_id.as_str())
                .or_insert(agent.id.as_str());
            *holder == agent.id
        })
        .take(free)
        .map(|agent| agent.id.clone())
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::{Outbox, Project, SessionSettings, Settings, Workspace};

    pub fn agent(id: &str, project: &str, status: Status, created: Timestamp) -> Agent {
        Agent {
            id: id.into(),
            project_id: project.into(),
            title: id.into(),
            prompt: id.into(),
            session_settings: SessionSettings::default(),
            status,
            created_at: created,
            updated_at: created,
            inbox_at: Some(created),
            base_branch: "main".into(),
            workspace: Workspace::Worktree {
                worktree: format!("/tmp/{id}").into(),
                branch: format!("pi-desk/{id}"),
            },
            session_id: id.into(),
            session_file: None,
            summary: None,
            question: None,
            outbox: None,
            snooze_until: None,
            note: None,
            started: false,
        }
    }

    fn state(agents: Vec<Agent>) -> State {
        State {
            projects: vec![
                Project {
                    id: "first".into(),
                    name: "First".into(),
                    path: "/a".into(),
                },
                Project {
                    id: "second".into(),
                    name: "Second".into(),
                    path: "/b".into(),
                },
            ],
            agents,
            settings: Settings {
                slots: 2,
                ..Settings::default()
            },
        }
    }

    #[test]
    fn inbox_recency_outweighs_project_rank() {
        let s = state(vec![
            agent("side-older", "second", Status::Review, 1),
            agent("main-recent", "first", Status::Review, 2),
            agent("side-newest", "second", Status::Question, 3),
            agent("main-oldest", "first", Status::Review, 0),
            agent("working", "first", Status::Working, 0),
        ]);
        let ids: Vec<&str> = inbox(&s, 10)
            .iter()
            .map(|agent| agent.id.as_str())
            .collect();
        assert_eq!(
            ids,
            ["side-newest", "main-recent", "side-older", "main-oldest"]
        );
    }

    #[test]
    fn display_order_uses_activity_then_creation_then_id() {
        let mut a = agent("a", "second", Status::Review, 1);
        let mut b = agent("b", "first", Status::Question, 2);
        a.updated_at = 10;
        a.inbox_at = Some(0);
        b.updated_at = 5;
        b.inbox_at = Some(20);
        assert_eq!(compare_display(&a, &b, 30), Ordering::Less);
        b.updated_at = 10;
        assert_eq!(compare_display(&a, &b, 30), Ordering::Greater);
        a.created_at = b.created_at;
        assert_eq!(compare_display(&a, &b, 30), Ordering::Less);
        assert_eq!(compare_display(&b, &a, 30), Ordering::Greater);
    }

    #[test]
    fn snoozed_tasks_form_the_later_group_but_done_stays_done() {
        let mut row = agent("later", "first", Status::Question, 0);
        row.snooze_until = Some(100);
        assert_eq!(display_group(&row, 99), DisplayGroup::Later);
        assert_eq!(display_group(&row, 100), DisplayGroup::NeedsYou);
        row.status = Status::Done {
            outcome: crate::model::Outcome::Merged,
        };
        assert_eq!(display_group(&row, 99), DisplayGroup::Done);
    }

    #[test]
    fn snoozed_rows_leave_the_inbox_until_due() {
        let mut row = agent("later", "first", Status::Review, 0);
        row.snooze_until = Some(100);
        let s = state(vec![row]);
        assert!(inbox(&s, 99).is_empty());
        assert_eq!(inbox(&s, 100).len(), 1);
    }

    #[test]
    fn slots_follow_project_order_then_replies_then_age() {
        let mut answered = agent("answered", "first", Status::Queued, 5);
        answered.outbox = Some(Outbox {
            text: "yes".into(),
            kind: OutboxKind::Answer,
        });
        let mut new = agent("new", "first", Status::Queued, 1);
        new.outbox = Some(Outbox {
            text: "task".into(),
            kind: OutboxKind::Initial,
        });
        let s = state(vec![
            agent("oldest", "first", Status::Queued, 0),
            new,
            answered,
            agent("other", "second", Status::Queued, 0),
        ]);
        assert_eq!(to_start(&s, 0, 0), ["answered", "oldest"]);
        assert_eq!(to_start(&s, 1, 0), ["answered"]);
        assert!(to_start(&s, 2, 0).is_empty());
    }

    fn main(id: &str, project: &str, status: Status, created: Timestamp) -> Agent {
        Agent {
            workspace: Workspace::Main {
                checkout: "/a".into(),
                start: "abc".into(),
            },
            ..agent(id, project, status, created)
        }
    }

    #[test]
    fn a_main_checkout_runs_one_task_per_project_until_it_is_done() {
        let mut s = state(vec![
            main("first-main", "first", Status::Queued, 0),
            main("second-main", "first", Status::Queued, 1),
            main("other-project", "second", Status::Queued, 2),
            agent("worktree", "first", Status::Queued, 3),
        ]);
        s.settings.slots = 4;
        assert_eq!(
            to_start(&s, 0, 0),
            ["first-main", "worktree", "other-project"]
        );

        // A started task holds the checkout while it waits for review.
        s.agents[0].started = true;
        s.agents[0].status = Status::Review;
        assert_eq!(to_start(&s, 0, 0), ["worktree", "other-project"]);

        // A reply re-queues the holder; it may start again.
        s.agents[0].status = Status::Queued;
        assert_eq!(
            to_start(&s, 0, 0),
            ["first-main", "worktree", "other-project"]
        );

        s.agents[0].status = Status::Done {
            outcome: crate::model::Outcome::Discarded,
        };
        assert_eq!(
            to_start(&s, 0, 0),
            ["second-main", "worktree", "other-project"]
        );
    }
}
