//! Display order is status, then most recent activity. Scheduling is separate:
//! Urgent first, then project rank and priority. Answers beat new work on a tie,
//! then older queued tasks start first.

use crate::model::{Agent, OutboxKind, Priority, State, Status, Timestamp};
use std::cmp::Ordering;

fn rank(state: &State, agent: &Agent) -> (bool, usize, Priority) {
    (
        agent.priority != Priority::Urgent,
        state.project_rank(&agent.project_id),
        agent.priority,
    )
}

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
    rank(state, a)
        .cmp(&rank(state, b))
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

/// Queued agents to start now, given how many are running.
pub fn to_start(state: &State, running: usize, at: Timestamp) -> Vec<String> {
    let free = state.settings.slots.max(1).saturating_sub(running);
    let mut queued: Vec<&Agent> = state
        .agents
        .iter()
        .filter(|agent| agent.status == Status::Queued && !agent.snoozed(at))
        .collect();
    queued.sort_by(|a, b| compare_queue(state, a, b));
    queued
        .into_iter()
        .take(free)
        .map(|agent| agent.id.clone())
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::{Outbox, Project, Settings};

    pub fn agent(
        id: &str,
        project: &str,
        priority: Priority,
        status: Status,
        created: Timestamp,
    ) -> Agent {
        Agent {
            id: id.into(),
            project_id: project.into(),
            title: id.into(),
            prompt: id.into(),
            priority,
            status,
            created_at: created,
            updated_at: created,
            inbox_at: Some(created),
            base_branch: "main".into(),
            branch: format!("pi-desk/{id}"),
            worktree: format!("/tmp/{id}").into(),
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
    fn inbox_recency_outweighs_priority_and_project_rank() {
        let s = state(vec![
            agent("side-high", "second", Priority::High, Status::Review, 1),
            agent("main-low", "first", Priority::Low, Status::Review, 2),
            agent(
                "side-urgent",
                "second",
                Priority::Urgent,
                Status::Question,
                3,
            ),
            agent("main-low-older", "first", Priority::Low, Status::Review, 0),
            agent("working", "first", Priority::Urgent, Status::Working, 0),
        ]);
        let ids: Vec<&str> = inbox(&s, 10)
            .iter()
            .map(|agent| agent.id.as_str())
            .collect();
        assert_eq!(
            ids,
            ["side-urgent", "main-low", "side-high", "main-low-older"]
        );
    }

    #[test]
    fn display_order_uses_activity_then_creation_then_id() {
        let mut a = agent("a", "second", Priority::Low, Status::Review, 1);
        let mut b = agent("b", "first", Priority::Urgent, Status::Question, 2);
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
        let mut row = agent("later", "first", Priority::Urgent, Status::Question, 0);
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
        let mut row = agent("later", "first", Priority::Medium, Status::Review, 0);
        row.snooze_until = Some(100);
        let s = state(vec![row]);
        assert!(inbox(&s, 99).is_empty());
        assert_eq!(inbox(&s, 100).len(), 1);
    }

    #[test]
    fn slots_start_the_most_important_and_answers_win_ties() {
        let mut answered = agent("answered", "first", Priority::Medium, Status::Queued, 5);
        answered.outbox = Some(Outbox {
            text: "yes".into(),
            kind: OutboxKind::Answer,
        });
        let mut new = agent("new", "first", Priority::Medium, Status::Queued, 1);
        new.outbox = Some(Outbox {
            text: "task".into(),
            kind: OutboxKind::Initial,
        });
        let s = state(vec![
            agent("low", "first", Priority::Low, Status::Queued, 0),
            new,
            answered,
            agent("other", "second", Priority::Urgent, Status::Queued, 0),
        ]);
        assert_eq!(to_start(&s, 0, 0), ["other", "answered"]);
        assert_eq!(to_start(&s, 1, 0), ["other"]);
        assert!(to_start(&s, 2, 0).is_empty());
    }
}
