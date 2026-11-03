use super::{ago, dot, empty, faint, line, preview::Preview, stable_column::StableColumn};
use crate::app::{App, Message, View};
use crate::model::{Agent, Status};
use crate::theme::{self, BOLD};
use crate::transcript::Entry;
use iced::widget::{Space, button, column, container, row, scrollable, text};
use iced::{Alignment, Element, Fill};

/// The second line of a row: what the agent needs or is doing.
pub fn subtitle(app: &App, agent: &Agent) -> String {
    if let Some(busy) = app.desk.busy(&agent.id) {
        return format!("{busy}…");
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
        Status::Working => {
            if let Some(note) = &agent.note {
                return note.clone();
            }
            let last = app.desk.transcripts.get(&agent.id).and_then(|transcript| {
                transcript
                    .entries
                    .iter()
                    .rev()
                    .find_map(|entry| match entry {
                        Entry::Tool {
                            name,
                            preview,
                            running: true,
                            ..
                        } => Some(format!("{name} {preview}")),
                        Entry::Assistant { text, .. } if !text.trim().is_empty() => text
                            .lines()
                            .rev()
                            .find(|line| !line.trim().is_empty())
                            .map(str::to_string),
                        _ => None,
                    })
            });
            last.unwrap_or_else(|| "Working…".into())
        }
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

/// Review previews separate the outcome from the next action instead of joining
/// unrelated fields with punctuation. Shared by the list and board cards.
pub fn preview(app: &App, agent: &Agent, max: usize) -> Element<'static, Message> {
    let mut lines = vec![line(&subtitle(app, agent), max)];
    if matches!(agent.status, Status::Review) {
        if let Some(summary) = &agent.summary {
            if !summary.needs.is_empty() {
                lines.push(format!("Needs: {}", line(&summary.needs, max)));
            }
        }
    }
    Preview::new(lines).into()
}

pub fn row_button<'a>(app: &'a App, agent: &'a Agent) -> Element<'a, Message> {
    let selected = app.selected.as_deref() == Some(agent.id.as_str());
    let project = app
        .desk
        .state
        .project(&agent.project_id)
        .map(|project| project.name.as_str())
        .unwrap_or("");
    let needs_user = agent.status.needs_user();
    let mut meta = row![faint(project)].spacing(6).align_y(Alignment::Center);
    if let Some(until) = agent.snooze_until.filter(|until| *until > app.now) {
        let when = chrono::DateTime::from_timestamp(until, 0)
            .map(|time| {
                time.with_timezone(&chrono::Local)
                    .format("until %a %H:%M")
                    .to_string()
            })
            .unwrap_or_default();
        meta = meta.push(faint(when));
    }
    let title = text(line(&agent.title, 60))
        .size(theme::size::BODY)
        .line_height(iced::Pixels(20.0))
        .font(if needs_user { BOLD } else { theme::SANS });
    let when = agent.updated_at;
    button(
        row![
            container(dot(theme::status_color(&agent.status)))
                .center_y(20)
                .id(format!("task-status-{}", agent.id)),
            column![
                row![title.width(Fill), faint(ago(app.now, when))]
                    .spacing(8)
                    .align_y(Alignment::Center),
                preview(app, agent, 90),
                meta,
            ]
            .spacing(3),
        ]
        .spacing(10),
    )
    .width(Fill)
    .padding([9, 12])
    .style(theme::row(selected))
    .on_press(Message::Select(agent.id.clone()))
    .into()
}

pub fn view(app: &App) -> Element<'_, Message> {
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
    let header = row![
        container(super::counted_heading(
            title,
            rows.len(),
            theme::size::TITLE
        ))
        .id("task-list-heading"),
        Space::new().width(Fill),
        super::sidebar_toggle(app),
        button(
            row![text("Board").size(theme::size::CAPTION), super::key("B")]
                .spacing(6)
                .align_y(Alignment::Center),
        )
        .style(theme::ghost)
        .padding([3, 8])
        .on_press(Message::ToggleBoard),
    ]
    .spacing(8)
    .align_y(Alignment::Center);

    let body: Element<'_, Message> = if rows.is_empty() {
        empty(hint, "")
    } else {
        let mut list = StableColumn::new(2.0);
        let mut previous_group = None;
        for agent in &rows {
            let group = crate::order::display_group(agent, app.now);
            if previous_group != Some(group) {
                list = list.push(
                    format!("group-{}", group.label()),
                    container(faint(group.label().to_uppercase()))
                        .id(format!("task-group-{}", group.label()))
                        .padding([6, 12]),
                );
                previous_group = Some(group);
            }
            list = list.push(format!("task-{}", agent.id), row_button(app, agent));
        }
        scrollable(list.padding([0, 8]))
            .style(theme::scrollbar)
            .height(Fill)
            .into()
    };

    container(column![container(header).padding([16, 20]), body].spacing(4))
        .width(380)
        .height(Fill)
        .into()
}
