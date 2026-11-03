//! A one-time entrance for each shaped text line. Text is always current; only
//! newly added rows move, never the paragraph or its already visible rows.
use crate::app::Message;
use iced::advanced::{Clipboard, Layout, Shell, Widget, layout, mouse, renderer, widget};
use iced::{Element, Event, Length, Rectangle, Renderer, Size, Theme, Vector, window};
use std::time::{Duration, Instant};

const DURATION: Duration = Duration::from_millis(180);
const DISTANCE: f32 = 6.0;

#[derive(Default)]
struct Lines {
    width: Option<f32>,
    seen: usize,
    entrances: Vec<(usize, Instant)>,
}

impl Lines {
    fn layout(&mut self, width: f32, count: usize, animate_initial: bool, now: Instant) {
        // Reflow is not streaming. Do not replay entrances on resize or zoom.
        if self.width.is_some_and(|old| (old - width).abs() > 0.5) {
            self.entrances.clear();
            self.seen = count;
        } else if self.width.is_some() || animate_initial {
            self.entrances
                .extend((self.seen..count).map(|line| (line, now)));
            // Keep a high-water mark: a Markdown reparse may briefly shrink a
            // paragraph, but revealing it again must not restart its lines.
            self.seen = self.seen.max(count);
        } else {
            self.seen = count;
        }
        self.width = Some(width);
    }

    fn advance(&mut self, now: Instant) {
        self.entrances
            .retain(|(_, start)| now.saturating_duration_since(*start) < DURATION);
    }

    fn offset(start: Instant, now: Instant) -> f32 {
        let t =
            (now.saturating_duration_since(start).as_secs_f32() / DURATION.as_secs_f32()).min(1.0);
        DISTANCE * (1.0 - t * t * (3.0 - 2.0 * t))
    }
}

pub(super) struct LineReveal<'a> {
    content: Element<'a, Message>,
    line_height: f32,
    animate_initial: bool,
}

impl<'a> LineReveal<'a> {
    pub fn new(
        content: impl Into<Element<'a, Message>>,
        line_height: f32,
        animate_initial: bool,
    ) -> Self {
        Self {
            content: content.into(),
            line_height,
            animate_initial,
        }
    }
}

impl Widget<Message, Theme, Renderer> for LineReveal<'_> {
    fn tag(&self) -> widget::tree::Tag {
        widget::tree::Tag::of::<Lines>()
    }
    fn state(&self) -> widget::tree::State {
        widget::tree::State::new(Lines::default())
    }
    fn children(&self) -> Vec<widget::Tree> {
        vec![widget::Tree::new(&self.content)]
    }
    fn diff(&self, tree: &mut widget::Tree) {
        tree.diff_children(std::slice::from_ref(&self.content));
    }
    fn size(&self) -> Size<Length> {
        self.content.as_widget().size()
    }
    fn layout(
        &mut self,
        tree: &mut widget::Tree,
        renderer: &Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        let node = self
            .content
            .as_widget_mut()
            .layout(&mut tree.children[0], renderer, limits);
        let count = (node.size().height / self.line_height).round() as usize;
        tree.state.downcast_mut::<Lines>().layout(
            limits.max().width,
            count,
            self.animate_initial,
            Instant::now(),
        );
        layout::Node::with_children(
            limits.resolve(
                if limits.max().width.is_finite() {
                    Length::Fill
                } else {
                    Length::Shrink
                },
                Length::Shrink,
                node.size(),
            ),
            vec![node],
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
        let lines = tree.state.downcast_mut::<Lines>();
        if let Event::Window(window::Event::RedrawRequested(now)) = event {
            lines.advance(*now);
        }
        if !lines.entrances.is_empty() {
            shell.request_redraw();
        }
        self.content.as_widget_mut().update(
            &mut tree.children[0],
            event,
            layout.children().next().unwrap(),
            cursor,
            renderer,
            clipboard,
            shell,
            viewport,
        );
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
        use iced::advanced::Renderer as _;
        let bounds = layout.bounds();
        let Some(clip) = bounds.intersection(viewport) else {
            return;
        };
        let lines = tree.state.downcast_ref::<Lines>();
        let child = layout.children().next().unwrap();
        let draw = |renderer: &mut Renderer, region: Rectangle, offset: f32| {
            let Some(visible) = region.intersection(&clip) else {
                return;
            };
            renderer.with_layer(visible, |renderer| {
                renderer.with_translation(Vector::new(0.0, offset), |renderer| {
                    // Clip before translating too, so the preceding row cannot
                    // bleed into an entering row's stripe.
                    renderer.with_layer(region, |renderer| {
                        self.content.as_widget().draw(
                            &tree.children[0],
                            renderer,
                            theme,
                            style,
                            child,
                            cursor,
                            viewport,
                        );
                    });
                });
            });
        };
        // Draw settled regions together. Streaming a long response only adds
        // one draw per entering line, not one draw per line in its history.
        let mut top = bounds.y;
        let now = Instant::now();
        for &(line, start) in &lines.entrances {
            let y = bounds.y + line as f32 * self.line_height;
            if y >= bounds.y + bounds.height {
                break;
            }
            if let Some(fixed) = (Rectangle {
                x: bounds.x,
                y: top,
                width: bounds.width,
                height: (y - top).max(0.0),
            })
            .intersection(&clip)
            {
                draw(renderer, fixed, 0.0);
            }
            draw(
                renderer,
                Rectangle {
                    x: bounds.x,
                    y,
                    width: bounds.width,
                    height: self.line_height,
                },
                Lines::offset(start, now),
            );
            top = y + self.line_height;
        }
        if let Some(fixed) = (Rectangle {
            x: bounds.x,
            y: top,
            width: bounds.width,
            height: (bounds.y + bounds.height - top).max(0.0),
        })
        .intersection(&clip)
        {
            draw(renderer, fixed, 0.0);
        }
    }
    fn operate(
        &mut self,
        tree: &mut widget::Tree,
        layout: Layout<'_>,
        renderer: &Renderer,
        operation: &mut dyn widget::Operation,
    ) {
        self.content.as_widget_mut().operate(
            &mut tree.children[0],
            layout.children().next().unwrap(),
            renderer,
            operation,
        );
    }
    fn mouse_interaction(
        &self,
        tree: &widget::Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &Renderer,
    ) -> mouse::Interaction {
        self.content.as_widget().mouse_interaction(
            &tree.children[0],
            layout.children().next().unwrap(),
            cursor,
            viewport,
            renderer,
        )
    }
}

impl<'a> From<LineReveal<'a>> for Element<'a, Message> {
    fn from(value: LineReveal<'a>) -> Self {
        Element::new(value)
    }
}

#[cfg(test)]
pub(super) fn active_lines(tree: &widget::Tree) -> Vec<(usize, Instant)> {
    let mut active = if tree.tag == widget::tree::Tag::of::<Lines>() {
        tree.state.downcast_ref::<Lines>().entrances.clone()
    } else {
        Vec::new()
    };
    for child in &tree.children {
        active.extend(active_lines(child));
    }
    active
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_never_restart_a_line_and_new_lines_have_independent_clocks() {
        let now = Instant::now();
        let mut lines = Lines::default();
        lines.layout(200.0, 1, false, now);
        assert!(lines.entrances.is_empty());
        lines.layout(200.0, 2, true, now);
        lines.layout(200.0, 2, true, now + DURATION / 3);
        lines.layout(200.0, 3, true, now + DURATION / 2);
        assert_eq!(lines.entrances, vec![(1, now), (2, now + DURATION / 2)]);
        lines.advance(now + DURATION);
        assert_eq!(lines.entrances, vec![(2, now + DURATION / 2)]);
        lines.advance(now + DURATION * 2);
        lines.layout(200.0, 2, true, now + DURATION * 3);
        lines.layout(200.0, 3, true, now + DURATION * 4);
        assert!(
            lines.entrances.is_empty(),
            "reparse must not replay old lines"
        );
    }

    #[test]
    fn new_paragraphs_enter_but_resize_and_zoom_do_not_replay() {
        let now = Instant::now();
        let mut lines = Lines::default();
        lines.layout(200.0, 2, true, now);
        assert_eq!(lines.entrances.len(), 2);
        lines.layout(100.0, 4, true, now);
        assert!(lines.entrances.is_empty());
        lines.layout(100.0, 5, true, now);
        assert_eq!(lines.entrances, vec![(4, now)]);
    }
}
