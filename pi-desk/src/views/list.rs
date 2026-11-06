use super::{ago, empty, faint, preview::Preview, stable_column::StableColumn};
use crate::app::{App, Message, View};
use crate::model::{Agent, Status};
use crate::text::one_line;
use crate::theme::{self, BOLD};
use crate::transcript::{AssistantBlock, Entry};
use iced::widget::{Space, button, column, container, row, scrollable, text};
use iced::{Alignment, Element, Fill};

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
                AssistantBlock::Text { text, .. } | AssistantBlock::Thinking { text } => text,
            };
            (!text.trim().is_empty()).then(|| crate::text::plain(text))
        })
    })
}

/// Review previews separate the outcome from the next action instead of joining
/// unrelated fields with punctuation. Shared by the list and board cards.
pub fn preview(app: &App, agent: &Agent, max: usize) -> Element<'static, Message> {
    // Working rows show the latest message, up to about two wrapped lines.
    let width = if matches!(agent.status, Status::Working) && app.desk.busy(&agent.id).is_none() {
        max * 2
    } else {
        max
    };
    let mut lines = vec![one_line(&subtitle(app, agent), width)];
    lines.retain(|line| !line.is_empty());
    if matches!(agent.status, Status::Review) {
        if let Some(summary) = &agent.summary {
            if !summary.needs.is_empty() {
                lines.push(format!("Needs: {}", one_line(&summary.needs, max)));
            }
        }
    }
    Preview::new(lines).into()
}

/// Title and age, preview, then project and snooze time. Shared by list rows
/// and board cards so both describe a task the same way.
pub fn summary<'a>(app: &'a App, agent: &'a Agent, title_max: usize) -> Element<'a, Message> {
    let project = app
        .desk
        .state
        .project(&agent.project_id)
        .map(|project| project.name.as_str())
        .unwrap_or("");
    let needs_user = agent.status.needs_user();
    let mut meta = row![faint(project)].spacing(6).align_y(Alignment::Center);
    if let Some(until) = agent.snooze_until.filter(|until| *until > app.now) {
        meta = meta.push(faint(format!("until {}", crate::later::clock(until))));
    }
    let title = text(one_line(&agent.title, title_max))
        .size(theme::size::BODY)
        .line_height(iced::Pixels(20.0))
        .font(if needs_user { BOLD } else { theme::SANS });
    column![
        row![title.width(Fill), faint(ago(app.now, agent.updated_at))]
            .spacing(8)
            .align_y(Alignment::Center),
        preview(app, agent, title_max * 3 / 2),
        meta,
    ]
    .spacing(3)
    .into()
}

pub fn row_button<'a>(app: &'a App, agent: &'a Agent) -> Element<'a, Message> {
    let selected = app.selected.as_deref() == Some(agent.id.as_str());
    button(summary(app, agent, 60))
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
                    container(super::counted_heading(
                        group.label(),
                        rows.iter()
                            .filter(|agent| crate::order::display_group(agent, app.now) == group)
                            .count(),
                        theme::size::CAPTION,
                    ))
                    .id(format!("task-group-{}", group.label()))
                    .padding(iced::Padding {
                        top: 10.0,
                        right: 12.0,
                        bottom: 4.0,
                        left: 12.0,
                    }),
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
