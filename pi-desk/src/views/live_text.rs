//! Current streaming text with one-time entrances for newly shaped lines.
//! A single Markdown tree preserves links and never queues stale snapshots.
use super::line_reveal::LineReveal;
use crate::{app::Message, theme};
use iced::advanced::{Clipboard, Layout, Shell, Widget, layout, mouse, renderer, widget};
use iced::widget::{column, container, markdown, rich_text, scrollable, text};
use iced::{Element, Event, Length, Rectangle, Renderer, Size, Theme};

struct State {
    key: String,
    value: String,
    content: markdown::Content,
    laid_out: bool,
}

impl State {
    fn new(key: String, value: String) -> Self {
        Self {
            key,
            content: markdown::Content::parse(&value),
            value,
            laid_out: false,
        }
    }
}

/// Use the same measured line height for rendering and entrance clipping.
struct Viewer {
    animate_initial: bool,
}

/// Markdown emphasis uses the same restrained weight as interface headings.
fn prose_spans(
    value: &markdown::Text,
    style: markdown::Style,
) -> Vec<text::Span<'static, markdown::Uri>> {
    value
        .spans(style)
        .iter()
        .cloned()
        .map(|mut span| {
            if span.link.is_some() {
                span.underline = true;
            }
            if let Some(font) = &mut span.font {
                if font.family == theme::SANS.family && font.weight == iced::font::Weight::Bold {
                    font.weight = theme::BOLD.weight;
                }
            }
            span
        })
        .collect()
}
impl<'a> markdown::Viewer<'a, Message> for Viewer {
    fn on_link_click(url: markdown::Uri) -> Message {
        Message::Link(url)
    }

    fn paragraph(
        &self,
        settings: markdown::Settings,
        value: &markdown::Text,
    ) -> Element<'a, Message> {
        self.lines(
            rich_text(prose_spans(value, settings.style))
                .size(settings.text_size)
                .line_height(theme::LINE_HEIGHT)
                .on_link_click(Message::Link),
            settings.text_size.0,
        )
    }

    fn heading(
        &self,
        settings: markdown::Settings,
        level: &'a markdown::HeadingLevel,
        value: &'a markdown::Text,
        index: usize,
    ) -> Element<'a, Message> {
        use markdown::HeadingLevel::*;
        let size = match level {
            H1 => settings.h1_size,
            H2 => settings.h2_size,
            H3 => settings.h3_size,
            H4 => settings.h4_size,
            H5 => settings.h5_size,
            H6 => settings.h6_size,
        };
        let mut style = settings.style;
        style.font = theme::BOLD;
        container(
            self.lines(
                rich_text(prose_spans(value, style))
                    .size(size)
                    .font(theme::BOLD)
                    .line_height(theme::LINE_HEIGHT)
                    .on_link_click(Message::Link),
                size.0,
            ),
        )
        .padding(iced::Padding::default().top(if index > 0 {
            settings.text_size.0 / 2.0
        } else {
            0.0
        }))
        .into()
    }

    fn code_block(
        &self,
        settings: markdown::Settings,
        _language: Option<&'a str>,
        _code: &'a str,
        lines: &'a [markdown::Text],
    ) -> Element<'a, Message> {
        let mut style = settings.style;
        style.font = settings.style.code_block_font;
        container(
            scrollable(
                container(column(lines.iter().map(|line| {
                    self.lines(
                        rich_text(line.spans(style))
                            .font(settings.style.code_block_font)
                            .size(settings.code_size)
                            .line_height(theme::LINE_HEIGHT)
                            .on_link_click(Message::Link),
                        settings.code_size.0,
                    )
                })))
                .padding(settings.code_size),
            )
            .style(theme::scrollbar)
            .direction(scrollable::Direction::Horizontal(
                scrollable::Scrollbar::default()
                    .width(settings.code_size / 2)
                    .scroller_width(settings.code_size / 2),
            )),
        )
        .width(Length::Fill)
        .padding(settings.code_size / 4)
        .style(container::dark)
        .into()
    }
}

impl Viewer {
    fn lines<'a>(
        &self,
        content: impl Into<Element<'a, Message>>,
        size: f32,
    ) -> Element<'a, Message> {
        LineReveal::new(content, size * theme::LINE_HEIGHT, self.animate_initial).into()
    }
}

pub(super) fn markdown_view(content: &markdown::Content) -> Element<'_, Message> {
    markdown::view_with(
        content.items(),
        super::detail::markdown_settings(),
        &Viewer {
            animate_initial: false,
        },
    )
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

    fn content<'a>(&self, state: &'a State) -> Element<'a, Message> {
        let viewer = Viewer {
            animate_initial: state.laid_out,
        };
        if self.markdown {
            markdown::view_with(
                state.content.items(),
                super::detail::markdown_settings(),
                &viewer,
            )
        } else {
            viewer.lines(
                text(state.value.clone())
                    .size(theme::size::CONTROL)
                    .line_height(theme::LINE_HEIGHT)
                    .color(theme::MUTED),
                theme::size::CONTROL,
            )
        }
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
        } else if state.value != self.value {
            state.content = markdown::Content::parse(&self.value);
            state.value.clone_from(&self.value);
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
        let mut content = self.content(tree.state.downcast_ref::<State>());
        if tree.children.is_empty() {
            tree.children.push(widget::Tree::new(&content));
        } else {
            tree.children[0].diff(&content);
        }
        let node = content.as_widget_mut().layout(
            &mut tree.children[0],
            renderer,
            &limits.width(Length::Fill),
        );
        drop(content);
        tree.state.downcast_mut::<State>().laid_out = true;
        layout::Node::with_children(node.size(), vec![node])
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
        self.content(tree.state.downcast_ref::<State>())
            .as_widget_mut()
            .update(
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
        self.content(tree.state.downcast_ref::<State>())
            .as_widget()
            .draw(
                &tree.children[0],
                renderer,
                theme,
                style,
                layout.children().next().unwrap(),
                cursor,
                viewport,
            );
    }
    fn operate(
        &mut self,
        tree: &mut widget::Tree,
        layout: Layout<'_>,
        renderer: &Renderer,
        operation: &mut dyn widget::Operation,
    ) {
        self.content(tree.state.downcast_ref::<State>())
            .as_widget_mut()
            .operate(
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
        self.content(tree.state.downcast_ref::<State>())
            .as_widget()
            .mouse_interaction(
                &tree.children[0],
                layout.children().next().unwrap(),
                cursor,
                viewport,
                renderer,
            )
    }
}
impl<'a> From<LiveText> for Element<'a, Message> {
    fn from(value: LiveText) -> Self {
        Element::new(value)
    }
}

#[cfg(test)]
#[path = "live_text_tests.rs"]
mod tests;
