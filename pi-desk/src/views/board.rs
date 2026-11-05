use super::{list::summary, stable_column::StableColumn};
use crate::app::{App, Message, View};
use crate::model::Agent;
use crate::order;
use crate::theme::{self, BOLD};
use iced::advanced::widget::{Id, Operation, operate, operation};
use iced::widget::{Space, button, column, container, row, scrollable, text};
use iced::{Alignment, Element, Fill, Rectangle, Task, Vector};

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
                container(
                    button(summary(app, agent, 40))
                        .width(Fill)
                        .padding([9, 12])
                        .style(theme::board_card(selected))
                        .on_press(Message::Open(agent.id.clone())),
                )
                .id(card_id(&agent.id))
                .width(Fill),
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
                    scrollable(cards)
                        .id(format!("board-column-{name}"))
                        .style(theme::scrollbar)
                        .height(Fill),
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

fn card_id(agent: &str) -> Id {
    Id::from(format!("board-card-{agent}"))
}

/// Scrolls the column that holds a task's card just far enough to show the
/// whole card, so keyboard selection never moves off screen.
pub fn reveal<T: Send + 'static>(agent: &str) -> Task<T> {
    operate(Reveal {
        card: card_id(agent),
        column: None,
        scroll: None,
    })
}

/// A column's scroll geometry as the operation last saw it.
struct Column {
    id: Option<Id>,
    viewport: Rectangle,
    content: Rectangle,
    offset: f32,
}

struct Reveal {
    card: Id,
    /// Columns are siblings and each one is visited before its cards, so the
    /// latest column is the one that holds the card.
    column: Option<Column>,
    scroll: Option<(Id, f32)>,
}

impl<T: Send + 'static> Operation<T> for Reveal {
    fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation<T>)) {
        if self.scroll.is_none() {
            operate(self);
        }
    }

    fn scrollable(
        &mut self,
        id: Option<&Id>,
        viewport: Rectangle,
        content: Rectangle,
        translation: Vector,
        _state: &mut dyn operation::Scrollable,
    ) {
        self.column = Some(Column {
            id: id.cloned(),
            viewport,
            content,
            offset: translation.y,
        });
    }

    fn container(&mut self, id: Option<&Id>, bounds: Rectangle) {
        if id != Some(&self.card) {
            return;
        }
        let Some(column) = &self.column else { return };
        let Some(column_id) = &column.id else { return };
        if let Some(offset) = revealed_offset(column, bounds) {
            self.scroll = Some((column_id.clone(), offset));
        }
    }

    fn finish(&self) -> operation::Outcome<T> {
        match &self.scroll {
            Some((id, y)) => operation::Outcome::Chain(Box::new(operation::scrollable::scroll_to(
                id.clone(),
                operation::scrollable::AbsoluteOffset {
                    x: None,
                    y: Some(*y),
                },
            ))),
            None => operation::Outcome::None,
        }
    }
}

/// The smallest scroll offset change that shows the whole card, if it is not
/// already shown. A card taller than the column shows its top.
fn revealed_offset(column: &Column, card: Rectangle) -> Option<f32> {
    let top = card.y - column.content.y;
    let bottom = top + card.height;
    if top < column.offset {
        Some(top)
    } else if bottom > column.offset + column.viewport.height {
        Some((bottom - column.viewport.height).min(top))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::advanced::renderer::Headless;
    use iced::advanced::widget::Tree;
    use iced::advanced::{Layout, layout};
    use iced::{Font, Pixels, Renderer, Size, Theme};

    const CARD: f32 = 100.0;
    const VIEWPORT: f32 = 250.0;

    struct Board {
        element: Element<'static, (), Theme, Renderer>,
        tree: Tree,
        node: layout::Node,
        renderer: Renderer,
    }

    impl Board {
        async fn new() -> Self {
            let renderer =
                <Renderer as Headless>::new(Font::DEFAULT, Pixels(16.0), Some("tiny-skia"))
                    .await
                    .expect("headless renderer");
            let mut cards = iced::widget::Column::new().spacing(10);
            for i in 0..10 {
                cards = cards.push(
                    container(Space::new().height(CARD))
                        .id(card_id(&format!("a{i}")))
                        .width(Fill),
                );
            }
            let mut element: Element<'static, (), Theme, Renderer> = scrollable(cards)
                .id("board-column-Inbox")
                .height(VIEWPORT)
                .into();
            let mut tree = Tree::new(&element);
            let node = element.as_widget_mut().layout(
                &mut tree,
                &renderer,
                &layout::Limits::new(Size::ZERO, Size::new(200.0, 1000.0)),
            );
            Self {
                element,
                tree,
                node,
                renderer,
            }
        }

        fn run(&mut self, mut operation: Box<dyn Operation>) {
            loop {
                self.element.as_widget_mut().operate(
                    &mut self.tree,
                    Layout::new(&self.node),
                    &self.renderer,
                    operation.as_mut(),
                );
                match operation.finish() {
                    operation::Outcome::Chain(next) => operation = next,
                    _ => return,
                }
            }
        }

        fn reveal(&mut self, agent: &str) {
            self.run(Box::new(Reveal {
                card: card_id(agent),
                column: None,
                scroll: None,
            }));
        }

        /// The card's top and bottom relative to the column's visible area.
        fn shown(&mut self, agent: &str) -> (f32, f32) {
            let mut measure = Measure {
                card: card_id(agent),
                origin: 0.0,
                found: None,
            };
            self.element.as_widget_mut().operate(
                &mut self.tree,
                Layout::new(&self.node),
                &self.renderer,
                &mut measure,
            );
            measure.found.expect("card")
        }
    }

    struct Measure {
        card: Id,
        origin: f32,
        found: Option<(f32, f32)>,
    }

    impl Operation for Measure {
        fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation)) {
            operate(self);
        }

        fn scrollable(
            &mut self,
            _: Option<&Id>,
            viewport: Rectangle,
            _: Rectangle,
            translation: Vector,
            _: &mut dyn operation::Scrollable,
        ) {
            self.origin = viewport.y + translation.y;
        }

        fn container(&mut self, id: Option<&Id>, bounds: Rectangle) {
            if id == Some(&self.card) {
                let top = bounds.y - self.origin;
                self.found = Some((top, top + bounds.height));
            }
        }
    }

    #[tokio::test]
    async fn reveal_scrolls_a_column_just_enough_to_show_the_card() {
        let mut board = Board::new().await;
        assert!(board.shown("a5").1 > VIEWPORT);

        board.reveal("a5");
        assert_eq!(
            board.shown("a5").1,
            VIEWPORT,
            "bottom aligns when moving down"
        );

        board.reveal("a4");
        assert_eq!(
            board.shown("a5").1,
            VIEWPORT,
            "a shown card keeps the scroll"
        );

        board.reveal("a1");
        assert_eq!(board.shown("a1").0, 0.0, "top aligns when moving up");
    }
}
