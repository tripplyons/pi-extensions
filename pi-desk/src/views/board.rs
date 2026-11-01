use super::{dot, faint, line, list::preview, stable_column::StableColumn};
use crate::app::{App, Message, View};
use crate::model::Agent;
use crate::order;
use crate::theme::{self, BOLD};
use iced::widget::{Space, button, column, container, row, scrollable, text};
use iced::{Alignment, Element, Fill};

/// Columns for the current scope: every project, or the selected one.
pub fn view(app: &App) -> Element<'_, Message> {
    let state = &app.desk.state;
    let scope = |agent: &&Agent| match &app.view {
        View::Project(id) => &agent.project_id == id,
        _ => true,
    };
    let at = app.now;
    let hidden = |agent: &&Agent| app.pending.iter().any(|pending| pending.id == agent.id);
    let mut columns: Vec<(&str, Vec<&Agent>)> = order::DisplayGroup::ALL
        .into_iter()
        .map(|group| {
            (
                group.label(),
                state
                    .agents
                    .iter()
                    .filter(|agent| order::display_group(agent, at) == group)
                    .collect(),
            )
        })
        .collect();
    for (name, agents) in &mut columns {
        agents.retain(|agent| scope(agent) && !hidden(agent));
        agents.sort_by(|a, b| order::compare_display(a, b, at));
        if *name == "Done" {
            agents.truncate(30);
        }
    }

    let mut board = row![].spacing(12);
    for (name, agents) in columns {
        let mut cards = StableColumn::new(8.0);
        for agent in agents.iter() {
            let selected = app.selected.as_deref() == Some(agent.id.as_str());
            let project = state
                .project(&agent.project_id)
                .map(|project| project.name.as_str())
                .unwrap_or("");
            cards = cards.push(
                agent.id.clone(),
                button(
                    column![
                        row![
                            dot(theme::status_color(&agent.status)),
                            text(line(&agent.title, 40)).size(13).font(BOLD)
                        ]
                        .spacing(8)
                        .align_y(Alignment::Center),
                        preview(app, agent, 70),
                        faint(project),
                    ]
                    .spacing(4),
                )
                .width(Fill)
                .padding(10)
                .style(move |theme, status| {
                    let mut style = theme::row(selected)(theme, status);
                    if !selected && style.background.is_none() {
                        style.background = Some(theme::SURFACE.into());
                    }
                    style.border = iced::Border {
                        color: theme::BORDER,
                        width: 1.0,
                        radius: 8.0.into(),
                    };
                    style
                })
                .on_press(Message::Open(agent.id.clone())),
            );
        }
        board = board.push(
            container(
                column![
                    container(super::counted_heading(name, agents.len(), 13.0))
                        .id(format!("board-heading-{name}")),
                    scrollable(cards).style(theme::scrollbar).height(Fill),
                ]
                .spacing(10),
            )
            .width(Fill)
            .height(Fill)
            .padding(10)
            .style(theme::panel),
        );
    }

    let header = row![
        text("Board").size(18).font(BOLD),
        Space::new().width(Fill),
        super::sidebar_toggle(app),
        button(
            row![text("List").size(12), super::key("B")]
                .spacing(6)
                .align_y(Alignment::Center),
        )
        .style(theme::ghost)
        .padding([3, 8])
        .on_press(Message::ToggleBoard),
    ]
    .spacing(8)
    .align_y(Alignment::Center);
    container(column![header, board].spacing(14))
        .padding([16, 20])
        .width(Fill)
        .height(Fill)
        .into()
}
