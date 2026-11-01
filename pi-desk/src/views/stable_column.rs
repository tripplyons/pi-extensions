//! Keep row widget state with its task when activity changes display order.

use crate::app::Message;
use iced::advanced::{Clipboard, Layout, Shell, Widget, layout, mouse, renderer, widget};
use iced::widget::{Column, column};
use iced::{Element, Event, Padding, Rectangle, Renderer, Size, Theme};
use std::collections::HashMap;

pub(super) struct StableColumn<'a> {
    keys: Vec<String>,
    content: Column<'a, Message>,
}

impl<'a> StableColumn<'a> {
    pub fn new(spacing: f32) -> Self {
        Self {
            keys: Vec::new(),
            content: column![].spacing(spacing),
        }
    }

    pub fn push(mut self, key: String, content: impl Into<Element<'a, Message>>) -> Self {
        self.keys.push(key);
        self.content = self.content.push(content);
        self
    }

    pub fn padding(mut self, padding: impl Into<Padding>) -> Self {
        self.content = self.content.padding(padding);
        self
    }
}

impl Widget<Message, Theme, Renderer> for StableColumn<'_> {
    fn tag(&self) -> widget::tree::Tag {
        widget::tree::Tag::of::<Vec<String>>()
    }

    fn state(&self) -> widget::tree::State {
        widget::tree::State::new(self.keys.clone())
    }

    fn children(&self) -> Vec<widget::Tree> {
        self.content.children()
    }

    fn diff(&self, tree: &mut widget::Tree) {
        let keys = tree.state.downcast_mut::<Vec<String>>();
        let mut previous: HashMap<_, _> = keys.drain(..).zip(tree.children.drain(..)).collect();
        tree.children = self
            .keys
            .iter()
            .zip(self.content.children())
            .map(|(key, fresh)| previous.remove(key).unwrap_or(fresh))
            .collect();
        keys.clone_from(&self.keys);
        self.content.diff(tree);
    }

    fn size(&self) -> Size<iced::Length> {
        self.content.size()
    }

    fn layout(
        &mut self,
        tree: &mut widget::Tree,
        renderer: &Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        self.content.layout(tree, renderer, limits)
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
        self.content.update(
            tree, event, layout, cursor, renderer, clipboard, shell, viewport,
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
        self.content
            .draw(tree, renderer, theme, style, layout, cursor, viewport);
    }

    fn operate(
        &mut self,
        tree: &mut widget::Tree,
        layout: Layout<'_>,
        renderer: &Renderer,
        operation: &mut dyn widget::Operation,
    ) {
        self.content.operate(tree, layout, renderer, operation);
    }

    fn mouse_interaction(
        &self,
        tree: &widget::Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &Renderer,
    ) -> mouse::Interaction {
        self.content
            .mouse_interaction(tree, layout, cursor, viewport, renderer)
    }
}

impl<'a> From<StableColumn<'a>> for Element<'a, Message> {
    fn from(column: StableColumn<'a>) -> Self {
        Element::new(column)
    }
}
