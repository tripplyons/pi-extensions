//! A clipped, frame-driven conveyor for task previews. Streaming updates replace
//! one pending value; they never restart an in-flight slide or build a queue.

use super::muted;
use crate::app::Message;
use iced::advanced::{Clipboard, Layout, Shell, Widget, layout, mouse, renderer, widget};
use iced::widget::column;
use iced::{Element, Event, Length, Point, Rectangle, Renderer, Size, Theme, window};
use std::time::{Duration, Instant};

#[cfg(test)]
#[path = "preview_tests.rs"]
mod tests;

const DURATION: Duration = Duration::from_millis(180);
type Lines = Vec<String>;

pub(super) struct Motion {
    pub(super) outgoing: Lines,
    pub(super) incoming: Lines,
    latest: Lines,
    pub(super) started: Option<Instant>,
    progress: f32,
}

impl Motion {
    pub(super) fn new(lines: Lines) -> Self {
        Self {
            outgoing: lines.clone(),
            incoming: lines.clone(),
            latest: lines,
            started: None,
            progress: 1.0,
        }
    }

    pub(super) fn retarget(&mut self, latest: &Lines, now: Instant) {
        self.latest.clone_from(latest);
        if self.started.is_none() && self.incoming != self.latest {
            self.start(now);
        }
    }

    fn start(&mut self, now: Instant) {
        self.outgoing.clone_from(&self.incoming);
        self.incoming.clone_from(&self.latest);
        self.started = Some(now);
        self.progress = 0.0;
    }

    pub(super) fn advance(&mut self, now: Instant) {
        let Some(started) = self.started else { return };
        let elapsed = now.saturating_duration_since(started);
        self.progress = (elapsed.as_secs_f32() / DURATION.as_secs_f32()).min(1.0);
        if self.progress == 1.0 {
            self.started = None;
            if self.incoming != self.latest {
                self.start(now);
            }
        }
    }

    pub(super) fn eased(&self) -> f32 {
        self.progress * self.progress * (3.0 - 2.0 * self.progress)
    }
}

pub(super) struct Preview {
    latest: Lines,
    // Built during layout from persistent widget state, like Iced's Responsive.
    content: Vec<Element<'static, Message>>,
}

impl Preview {
    pub fn new(lines: Lines) -> Self {
        Self {
            latest: lines,
            content: Vec::new(),
        }
    }
}

fn content(lines: &Lines) -> Element<'static, Message> {
    column(lines.iter().cloned().map(|line| muted(line).into()))
        .spacing(3)
        .width(Length::Fill)
        .into()
}

impl Widget<Message, Theme, Renderer> for Preview {
    fn tag(&self) -> widget::tree::Tag {
        widget::tree::Tag::of::<Motion>()
    }

    fn state(&self) -> widget::tree::State {
        widget::tree::State::new(Motion::new(self.latest.clone()))
    }

    fn diff(&self, tree: &mut widget::Tree) {
        tree.state
            .downcast_mut::<Motion>()
            .retarget(&self.latest, Instant::now());
        // Child reconciliation is deferred to layout, where both texts are known.
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
        let motion = tree.state.downcast_ref::<Motion>();
        let moving = motion.started.is_some();
        let progress = motion.eased();
        self.content = if moving {
            vec![content(&motion.outgoing), content(&motion.incoming)]
        } else {
            vec![content(&motion.incoming)]
        };
        tree.diff_children(&self.content);
        let limits = limits.width(Length::Fill);
        let mut nodes: Vec<_> = self
            .content
            .iter_mut()
            .zip(&mut tree.children)
            .map(|(content, tree)| {
                content
                    .as_widget_mut()
                    .layout(tree, renderer, &limits.loose())
            })
            .collect();
        let old_height = nodes[0].size().height;
        let new_height = nodes.last().unwrap().size().height;
        let height = old_height + (new_height - old_height) * progress;
        let width = nodes.last().unwrap().size().width;
        if moving {
            // The two texts share an edge while the viewport grows or shrinks.
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
        _layout: Layout<'_>,
        _cursor: mouse::Cursor,
        _renderer: &Renderer,
        _clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        _viewport: &Rectangle,
    ) {
        let motion = tree.state.downcast_mut::<Motion>();
        if let Event::Window(window::Event::RedrawRequested(now)) = event {
            if motion.started.is_some() {
                motion.advance(*now);
                shell.invalidate_layout();
            }
        }
        if motion.started.is_some() {
            shell.request_redraw();
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
        renderer.with_layer(clip, |renderer| {
            for ((content, tree), child) in self
                .content
                .iter()
                .zip(&tree.children)
                .zip(layout.children())
            {
                content
                    .as_widget()
                    .draw(tree, renderer, theme, style, child, cursor, &clip);
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
        operation.traverse(&mut |operation| {
            // Expose only the replacement, not duplicate outgoing text.
            if let Some(((content, tree), child)) = self
                .content
                .iter_mut()
                .zip(&mut tree.children)
                .zip(layout.children())
                .last()
            {
                content
                    .as_widget_mut()
                    .operate(tree, child, renderer, operation);
            }
        });
    }
}

impl From<Preview> for Element<'static, Message> {
    fn from(preview: Preview) -> Self {
        Element::new(preview)
    }
}
