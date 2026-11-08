use super::{counted_heading, list::summary, send};
use crate::app::{App, Message, View};
use crate::model::Agent;
use crate::order;
use crate::theme::{self, P, size};
use rune::{El, ScrollSpec, col, row};

/// The key of a task's board card, for scrolling it into view.
pub fn card_key(agent: &str) -> String {
    format!("board-card-{agent}")
}

/// Columns for the current scope: every project, or the selected one.
pub fn view(app: &App) -> El {
    let state = &app.desk.state;
    let scope = |agent: &&Agent| match &app.view {
        View::Project(id) => &agent.project_id == id,
        _ => true,
    };
    let at = app.now;
    let mut board = row().key("columns").w_full().grow(1.0).min_h(0.0).gap(12.0);
    for group in order::DisplayGroup::ALL {
        let name = group.label();
        let mut agents: Vec<&Agent> = state
            .agents
            .iter()
            .filter(|agent| {
                order::display_group(agent, at) == group && scope(agent) && !app.hidden(&agent.id)
            })
            .collect();
        agents.sort_by(|a, b| order::compare_display(a, b, at));
        if group == order::DisplayGroup::Done && agents.len() > 30 {
            // The selected task stays listed even past the cut.
            let selected = agents
                .iter()
                .position(|agent| app.selected.as_deref() == Some(agent.id.as_str()));
            let kept = selected
                .filter(|index| *index >= 30)
                .map(|index| agents[index]);
            agents.truncate(30);
            agents.extend(kept);
        }
        let mut cards = col().key("cards").w_full().gap(8.0).pb(4.0);
        for agent in agents.iter() {
            let selected = app.selected.as_deref() == Some(agent.id.as_str());
            cards = cards.child(
                col()
                    .key(card_key(&agent.id))
                    .w_full()
                    .px(12.0)
                    .py(10.0)
                    .radius(8.0)
                    .fill(if selected { P.selected } else { P.raised })
                    .border(1.0, if selected { P.border_strong } else { P.border })
                    .hover(P.hover)
                    .press(P.press)
                    .motion(theme::SNAPPY)
                    .role("button")
                    .label(agent.title.as_str())
                    .on_press_tx(send(Message::Open(agent.id.clone())))
                    .child(summary(app, agent)),
            );
        }
        board = board.child(
            col()
                .key(format!("board-column-{name}"))
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .h_full()
                .padding(8.0)
                .gap(8.0)
                .radius(10.0)
                .fill(P.surface)
                .border(1.0, P.border_soft)
                .child(
                    counted_heading(name, agents.len(), size::CONTROL)
                        .key(format!("board-heading-{name}"))
                        .px(4.0)
                        .py(4.0),
                )
                .child(
                    col()
                        .key("scroll")
                        .w_full()
                        .grow(1.0)
                        .min_h(0.0)
                        .scroll(ScrollSpec { stick_bottom: false })
                        .scroll_edge_fade(10.0)
                        .child(cards),
                ),
        );
    }

    let header = row()
        .key("board-header")
        .w_full()
        .gap(8.0)
        .center_y()
        .child(super::strong("Board", size::TITLE, P.text).grow(1.0))
        .child(super::sidebar_toggle(app))
        .child(super::ghost(
            "list-toggle",
            "List",
            &[crate::icon::KeyPart::Text("B")],
            Message::ToggleBoard,
        ));
    col()
        .key("board")
        .grow(1.0)
        .shrink()
        .min_w(0.0)
        .h_full()
        .px(20.0)
        .py(16.0)
        .gap(14.0)
        .child(header)
        .child(board)
}
