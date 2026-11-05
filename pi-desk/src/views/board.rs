use super::{list::summary, stable_column::StableColumn};
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
            cards = cards.push(
                agent.id.clone(),
                button(summary(app, agent, 40))
                    .width(Fill)
                    .padding([9, 12])
                    .style(theme::board_card(selected))
                    .on_press(Message::Open(agent.id.clone())),
            );
        }
        board = board.push(
            container(
                column![
                    container(super::counted_heading(
                        name,
                        agents.len(),
                        theme::size::CONTROL
                    ))
                    .id(format!("board-heading-{name}"))
                    .padding([4, 4]),
                    scrollable(cards).style(theme::scrollbar).height(Fill),
                ]
                .spacing(8),
            )
            .width(Fill)
            .height(Fill)
            .padding(8)
            .style(theme::board_column),
        );
    }

    let header = row![
        text("Board").size(theme::size::TITLE).font(BOLD),
        Space::new().width(Fill),
        super::sidebar_toggle(app),
        button(
            row![text("List").size(theme::size::CAPTION), super::key("B")]
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
