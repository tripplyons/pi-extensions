//! Sliding live text. Snapshot rendering keeps Markdown links interactive while
//! the shared preview clock coalesces streaming updates.
use super::preview::Motion;
use crate::{app::Message, theme};
use iced::advanced::{Clipboard, Layout, Shell, Widget, layout, mouse, renderer, widget};
use iced::widget::{markdown, text};
use iced::{Element, Event, Length, Point, Rectangle, Renderer, Size, Theme, window};
use std::time::Instant;

struct State {
    key: String,
    motion: Motion,
    outgoing: markdown::Content,
    incoming: markdown::Content,
}

impl State {
    fn new(key: String, value: String) -> Self {
        Self {
            key,
            motion: Motion::new(vec![value.clone()]),
            outgoing: markdown::Content::parse(&value),
            incoming: markdown::Content::parse(&value),
        }
    }

    fn sync(&mut self) {
        self.outgoing = markdown::Content::parse(&self.motion.outgoing[0]);
        self.incoming = markdown::Content::parse(&self.motion.incoming[0]);
    }
}

pub(super) struct LiveText {
    key: String,
    value: String,
    markdown: bool,
}

impl LiveText {
    pub fn new(key: String, value: String, markdown: bool) -> Self {
        Self {
            key,
            value,
            markdown,
        }
    }

    fn content<'a>(&self, state: &'a State) -> Vec<Element<'a, Message>> {
        let render = |value: &String, content: &'a markdown::Content| -> Element<'a, Message> {
            if self.markdown {
                markdown::view(content.items(), super::detail::markdown_settings())
                    .map(Message::Link)
            } else {
                text(value.clone()).size(13).color(theme::MUTED).into()
            }
        };
        let mut content = Vec::new();
        if state.motion.started.is_some() {
            content.push(render(&state.motion.outgoing[0], &state.outgoing));
        }
        content.push(render(&state.motion.incoming[0], &state.incoming));
        content
    }
}

impl Widget<Message, Theme, Renderer> for LiveText {
    fn tag(&self) -> widget::tree::Tag {
        widget::tree::Tag::of::<State>()
    }
    fn state(&self) -> widget::tree::State {
        widget::tree::State::new(State::new(self.key.clone(), self.value.clone()))
    }
    fn diff(&self, tree: &mut widget::Tree) {
        let state = tree.state.downcast_mut::<State>();
        if state.key != self.key {
            *state = State::new(self.key.clone(), self.value.clone());
            tree.children.clear();
        } else {
            let before = state.motion.incoming.clone();
            state
                .motion
                .retarget(&vec![self.value.clone()], Instant::now());
            if before != state.motion.incoming {
                state.sync();
            }
        }
    }
    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Shrink)
    }
    fn layout(
        &mut self,
        tree: &mut widget::Tree,
        renderer: &Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        let state = tree.state.downcast_ref::<State>();
        let moving = state.motion.started.is_some();
        let progress = state.motion.eased();
        let mut content = self.content(state);
        // Keep children separate from the snapshot state they borrow.
        tree.children.truncate(content.len());
        while tree.children.len() < content.len() {
            tree.children
                .push(widget::Tree::new(&content[tree.children.len()]));
        }
        for (child, element) in tree.children.iter_mut().zip(&content) {
            child.diff(element);
        }
        let limits = limits.width(Length::Fill);
        let mut nodes: Vec<_> = content
            .iter_mut()
            .zip(&mut tree.children)
            .map(|(element, child)| {
                element
                    .as_widget_mut()
                    .layout(child, renderer, &limits.loose())
            })
            .collect();
        let old_height = nodes[0].size().height;
        let new_height = nodes.last().unwrap().size().height;
        let height = old_height + (new_height - old_height) * progress;
        let width = nodes.last().unwrap().size().width;
        if moving {
            nodes[0].move_to_mut(Point::new(0.0, -progress * old_height));
            nodes[1].move_to_mut(Point::new(0.0, (1.0 - progress) * old_height));
        }
        layout::Node::with_children(
            limits.resolve(Length::Fill, Length::Shrink, Size::new(width, height)),
            nodes,
        )
    }
    fn update(
        &mut self,
        tree: &mut widget::Tree,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        renderer: &Renderer,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        let state = tree.state.downcast_mut::<State>();
        if let Event::Window(window::Event::RedrawRequested(now)) = event {
            if state.motion.started.is_some() {
                let before = state.motion.incoming.clone();
                state.motion.advance(*now);
                if before != state.motion.incoming {
                    state.sync();
                }
                shell.invalidate_layout();
                // The current layout belongs to the previous snapshots.
                if state.motion.started.is_some() {
                    shell.request_redraw();
                }
                return;
            }
        }
        if state.motion.started.is_some() {
            shell.request_redraw();
        }
        // Only the incoming snapshot accepts input.
        if let Some(((mut element, child), bounds)) = self
            .content(state)
            .into_iter()
            .zip(&mut tree.children)
            .zip(layout.children())
            .last()
        {
            element.as_widget_mut().update(
                child, event, bounds, cursor, renderer, clipboard, shell, viewport,
            );
        }
    }
    fn draw(
        &self,
        tree: &widget::Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        style: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        let Some(clip) = layout.bounds().intersection(viewport) else {
            return;
        };
        use iced::advanced::Renderer as _;
        let content = self.content(tree.state.downcast_ref::<State>());
        renderer.with_layer(clip, |renderer| {
            for ((element, child), bounds) in
                content.iter().zip(&tree.children).zip(layout.children())
            {
                element
                    .as_widget()
                    .draw(child, renderer, theme, style, bounds, cursor, &clip);
            }
        });
    }
    fn operate(
        &mut self,
        tree: &mut widget::Tree,
        layout: Layout<'_>,
        renderer: &Renderer,
        operation: &mut dyn widget::Operation,
    ) {
        operation.container(None, layout.bounds());
        let mut content = self.content(tree.state.downcast_ref::<State>());
        operation.traverse(&mut |operation| {
            if let Some(((element, child), bounds)) = content
                .iter_mut()
                .zip(&mut tree.children)
                .zip(layout.children())
                .last()
            {
                element
                    .as_widget_mut()
                    .operate(child, bounds, renderer, operation);
            }
        });
    }
    fn mouse_interaction(
        &self,
        tree: &widget::Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &Renderer,
    ) -> mouse::Interaction {
        self.content(tree.state.downcast_ref::<State>())
            .iter()
            .zip(&tree.children)
            .zip(layout.children())
            .last()
            .map(|((element, child), bounds)| {
                element
                    .as_widget()
                    .mouse_interaction(child, bounds, cursor, viewport, renderer)
            })
            .unwrap_or_default()
    }
}

impl<'a> From<LiveText> for Element<'a, Message> {
    fn from(value: LiveText) -> Self {
        Element::new(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::advanced::renderer::Headless;
    use iced::{Font, Pixels};
    use std::time::Duration;

    #[tokio::test]
    async fn live_markdown_slides_coalesces_and_resets_on_agent_switch() {
        let renderer = <Renderer as Headless>::new(Font::DEFAULT, Pixels(16.0), Some("tiny-skia"))
            .await
            .expect("headless renderer");
        let limits = layout::Limits::new(Size::ZERO, Size::new(200.0, 500.0));
        let mut value = LiveText::new("a:1".into(), "Old **text**".into(), true);
        let mut tree = widget::Tree::new(&value as &dyn Widget<Message, Theme, Renderer>);
        let initial = value.layout(&mut tree, &renderer, &limits);
        assert!(tree.state.downcast_ref::<State>().motion.started.is_none());
        value.value =
            "New [link](https://example.com) with enough text to wrap over multiple lines".into();
        value.diff(&mut tree);
        let start = tree.state.downcast_ref::<State>().motion.started.unwrap();
        let first = value.layout(&mut tree, &renderer, &limits);
        assert_eq!(first.size().height, initial.size().height);
        value.value = "Latest **replacement**".into();
        value.diff(&mut tree);
        assert_eq!(
            tree.state.downcast_ref::<State>().motion.started,
            Some(start)
        );
        let mut messages = Vec::new();
        let mut shell = Shell::new(&mut messages);
        value.update(
            &mut tree,
            &Event::Window(window::Event::RedrawRequested(
                start + Duration::from_millis(90),
            )),
            Layout::new(&first),
            mouse::Cursor::Unavailable,
            &renderer,
            &mut iced::advanced::clipboard::Null,
            &mut shell,
            &Rectangle::with_size(Size::new(200.0, 500.0)),
        );
        assert!(shell.is_layout_invalid());
        let middle = value.layout(&mut tree, &renderer, &limits);
        assert!(middle.children()[0].bounds().y < 0.0);
        assert!(middle.children()[1].bounds().y > 0.0);
        // Only one pending update is retained and its Markdown is refreshed.
        value.update(
            &mut tree,
            &Event::Window(window::Event::RedrawRequested(
                start + Duration::from_millis(180),
            )),
            Layout::new(&middle),
            mouse::Cursor::Unavailable,
            &renderer,
            &mut iced::advanced::clipboard::Null,
            &mut shell,
            &Rectangle::with_size(Size::new(200.0, 500.0)),
        );
        let state = tree.state.downcast_ref::<State>();
        assert_eq!(state.motion.incoming[0], "Latest **replacement**");
        assert!(!state.incoming.items().is_empty());
        value.key = "b:1".into();
        value.diff(&mut tree);
        let switched = value.layout(&mut tree, &renderer, &limits);
        assert_eq!(switched.children().len(), 1);
        assert!(tree.state.downcast_ref::<State>().motion.started.is_none());
        value.diff(&mut tree);
        assert!(tree.state.downcast_ref::<State>().motion.started.is_none());
    }
}
