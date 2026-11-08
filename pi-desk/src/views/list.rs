use super::{ago, chip, empty, faint, icon, label, send};
use crate::app::{App, Message, View};
use crate::goal::GoalStatus;
use crate::icon::Icon;
use crate::model::{Agent, Status};
use crate::text::one_line;
use crate::theme::{self, P, size};
use crate::transcript::{AssistantBlock, Entry};
use rune::{El, ScrollSpec, col, row, text};

pub const WIDTH: f32 = 380.0;

/// The second line of a row: what the agent needs or is doing.
pub fn subtitle(app: &App, agent: &Agent) -> String {
    if let Some(busy) = app.desk.busy(&agent.id) {
        return format!("{}…", busy.label());
    }
    match &agent.status {
        Status::Question => agent
            .question
            .as_ref()
            .map(|question| question.text.clone())
            .unwrap_or_default(),
        Status::Review => agent
            .summary
            .as_ref()
            .map(|summary| summary.did.clone())
            .unwrap_or_else(|| "Finished".into()),
        Status::Failed { error } => error.lines().next().unwrap_or("Failed").to_string(),
        Status::Working => latest_message(app, agent)
            .or_else(|| agent.note.clone())
            .unwrap_or_else(|| "Working…".into()),
        Status::Queued => agent.note.clone().unwrap_or_else(|| {
            if agent.started {
                "Waiting for a free slot".into()
            } else {
                "Queued".into()
            }
        }),
        Status::Done { .. } => agent
            .summary
            .as_ref()
            .map(|summary| summary.did.clone())
            .unwrap_or_else(|| agent.status.label().into()),
    }
}

/// The newest non-empty assistant text or thinking block, from its start.
fn latest_message(app: &App, agent: &Agent) -> Option<String> {
    let transcript = app.desk.transcripts.get(&agent.id)?;
    transcript.entries.iter().rev().find_map(|entry| {
        let Entry::Assistant { blocks, .. } = entry else {
            return None;
        };
        blocks.values().rev().find_map(|block| {
            let text = match block {
                AssistantBlock::Text { text } | AssistantBlock::Thinking { text } => text,
            };
            (!text.trim().is_empty()).then(|| crate::text::plain(text))
        })
    })
}

/// Review previews separate the outcome from the next action instead of joining
/// unrelated fields with punctuation.
pub fn preview(app: &App, agent: &Agent) -> El {
    let lines = 2;
    let mut column = col().key("preview").w_full().gap(2.0).child(
        text(one_line(&subtitle(app, agent), 400))
            .font(theme::tight(size::CONTROL))
            .color(P.muted)
            .key("subtitle")
            .wrap()
            .max_lines(lines),
    );
    if matches!(agent.status, Status::Review)
        && let Some(summary) = &agent.summary
        && !summary.needs.is_empty()
    {
        column = column.child(
            text(format!("Needs: {}", one_line(&summary.needs, 400)))
                .font(theme::tight(size::CONTROL))
                .color(P.muted)
                .key("needs")
            .truncate(),
        );
    }
    column
}

/// The goal line under a row's preview, when the task has one.
pub fn goal_line(app: &App, agent: &Agent) -> Option<El> {
    let goal = app.goal(&agent.id)?;
    let color = match goal.status {
        GoalStatus::Active => P.accent,
        _ => P.amber,
    };
    let mut line = row()
        .key(format!("goal-line-{}", agent.id))
        .w_full()
        .gap(6.0)
        .center_y()
        .child(icon(Icon::Target, 12.0, color))
        .child(
            label(one_line(&goal.objective, 200), size::CAPTION, P.text)
                .shrink()
                .truncate(),
        );
    if goal.status != GoalStatus::Active {
        line = line.child(chip(goal.status.label(), color).key("goal-status"));
    }
    Some(line)
}

/// "N agents" for a swarm root with active workers.
pub fn agents_chip(app: &App, agent: &Agent) -> Option<El> {
    let count = app.workers(&agent.id).len();
    (count > 0).then(|| {
        row()
            .key("agents")
            .h(18.0)
            .px(6.0)
            .gap(4.0)
            .center_y()
            .radius(9.0)
            .fill(P.accent.alpha(0.14))
            .child(icon(Icon::Users, 11.0, P.accent))
            .child(
                text(format!(
                    "{count} {}",
                    if count == 1 { "agent" } else { "agents" }
                ))
                .font(theme::medium(size::CAPTION - 1.0))
                .color(P.accent),
            )
    })
}

/// Title and age, preview, goal, then project, agents, and snooze time.
fn summary(app: &App, agent: &Agent) -> El {
    let project = app
        .desk
        .state
        .project(&agent.project_id)
        .map(|project| project.name.as_str())
        .unwrap_or("");
    let needs_user = agent.status.needs_user();
    let mut meta = row()
        .key("meta")
        .w_full()
        .gap(6.0)
        .center_y()
        .child(
            text(project)
                .font(theme::tight(size::CAPTION))
                .color(P.faint)
                .shrink()
                .truncate(),
        );
    if let Some(chip) = agents_chip(app, agent) {
        meta = meta.child(chip);
    }
    if let Some(until) = agent.snooze_until.filter(|until| *until > app.now) {
        meta = meta.child(
            text(format!("until {}", crate::later::clock(until)))
                .font(theme::tight(size::CAPTION))
                .color(P.faint),
        );
    }
    let mut title_style = if needs_user {
        theme::bold(size::BODY)
    } else {
        theme::sans(size::BODY)
    };
    title_style.line_height = 20.0;
    let title = text(agent.title.as_str())
        .font(title_style)
        .color(P.text)
        .grow(1.0)
        .shrink()
        .truncate();
    let mut column = col()
        .key("summary")
        .w_full()
        .gap(3.0)
        .child(
            row()
                .key("title-line")
                .w_full()
                .gap(8.0)
                .center_y()
                .child(title)
                .child(faint(ago(app.now, agent.updated_at))),
        )
        .child(preview(app, agent));
    if let Some(goal) = goal_line(app, agent) {
        column = column.child(goal);
    }
    column.child(meta)
}

pub fn row_button(app: &App, agent: &Agent) -> El {
    let selected = app.selected.as_deref() == Some(agent.id.as_str());
    super::selectable(
        col()
            .key(super::row_key(&agent.id))
            .w_full()
            .px(12.0)
            .py(9.0)
            .role("button")
            .label(agent.title.as_str())
            .on_press_tx(send(Message::Select(agent.id.clone())))
            .child(summary(app, agent)),
        selected,
    )
}

pub fn view(app: &App) -> El {
    let rows = app.rows();
    let (title, hint) = match &app.view {
        View::All => ("All tasks", "No tasks yet. Press N to file work."),
        View::Inbox => ("Inbox", "Nothing needs you. Press N to file work."),
        View::Working => ("Working", "No agents are running or queued."),
        View::Later => ("Later", "Nothing is put off."),
        View::Done => ("Done", "Merged, discarded, and closed tasks appear here."),
        View::Project(id) => (
            app.desk
                .state
                .project(id)
                .map(|project| project.name.as_str())
                .unwrap_or("Project"),
            "No open tasks in this project. Press N to file one.",
        ),
    };
    let header = row()
        .key("list-header")
        .w_full()
        .px(20.0)
        .pt(16.0)
        .pb(12.0)
        .gap(8.0)
        .center_y()
        .child(
            super::counted_heading(title, rows.len(), size::TITLE)
                .key("task-list-heading")
                .grow(1.0)
                .shrink()
                .truncate(),
        )
        .child(super::sidebar_toggle(app));

    let body = if rows.is_empty() {
        empty("no-rows", hint, "")
    } else {
        let mut list = col().key("rows").w_full().gap(2.0).px(8.0).pb(12.0);
        let mut previous_group = None;
        for agent in &rows {
            let group = crate::order::display_group(agent, app.now);
            if previous_group != Some(group) {
                list = list.child(
                    super::counted_heading(
                        group.label(),
                        rows.iter()
                            .filter(|agent| crate::order::display_group(agent, app.now) == group)
                            .count(),
                        size::CAPTION,
                    )
                    .key(format!("task-group-{}", group.label()))
                    .px(12.0)
                    .pt(10.0)
                    .pb(4.0),
                );
                previous_group = Some(group);
            }
            list = list.child(row_button(app, agent));
        }
        col()
            .key("list-scroll")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .scroll(ScrollSpec { stick_bottom: false })
            .scroll_edge_fade(12.0)
            .child(list)
    };

    col()
        .key("list")
        .w(WIDTH)
        .h_full()
        .child(header)
        .child(body)
}
