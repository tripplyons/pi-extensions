//! Window layout: sidebar, row list, and detail pane, with focus mode, the
//! board, and overlays on top.

mod board;
mod card;
mod detail;
mod line_reveal;
mod list;
mod live_text;
mod overlays;
mod preview;
mod session;
mod sidebar;
mod stable_column;

use crate::app::{App, Message};
use crate::model::Timestamp;
use crate::theme::{self, BOLD, FAINT, MONO, MUTED};
use iced::widget::{
    Space, button, column, container, opaque, rich_text, row, rule, span, stack, text,
};
use iced::{Alignment, Color, Element, Fill, Length, Padding};

pub fn root(app: &App) -> Element<'_, Message> {
    let body: Element<'_, Message> = if app.focus && app.current().is_some() {
        container(
            column![card::view(app), detail::view(app)]
                .spacing(16)
                .max_width(900),
        )
        .padding(Padding {
            top: 24.0,
            right: 32.0,
            bottom: 24.0,
            left: 32.0,
        })
        .center_x(Fill)
        .height(Fill)
        .into()
    } else {
        let mut panes = row![];
        if app.show_sidebar {
            panes = panes
                .push(sidebar::view(app))
                .push(rule::vertical(1).style(divider));
        }
        if app.board {
            panes.push(board::view(app)).into()
        } else {
            panes
                .push(list::view(app))
                .push(rule::vertical(1).style(divider))
                .push(detail::pane(app))
                .into()
        }
    };
    let mut page = column![];
    if let Some(error) = &app.error {
        page = page.push(
            container(
                row![
                    text(error.as_str()).size(theme::size::CONTROL).width(Fill),
                    button(text("Dismiss").size(theme::size::CAPTION))
                        .style(theme::ghost)
                        .on_press(Message::DismissError)
                ]
                .spacing(12)
                .align_y(Alignment::Center),
            )
            .padding([8, 14])
            .style(theme::error_banner),
        );
    }
    page = page.push(body);
    let base = container(page)
        .width(Fill)
        .height(Fill)
        .style(theme::window);

    let mut layers = stack![base].width(Fill).height(Fill);
    if let Some(bar) = status_bar(app) {
        layers = layers.push(
            container(bar)
                .width(Fill)
                .height(Fill)
                .align_x(Alignment::Center)
                .align_y(Alignment::End)
                .padding(18),
        );
    }
    if let Some(sheet) = overlays::view(app) {
        layers = layers.push(opaque(
            container(sheet)
                .width(Fill)
                .height(Fill)
                .align_x(Alignment::Center)
                .padding(Padding {
                    top: 90.0,
                    ..Padding::ZERO
                })
                .style(theme::scrim),
        ));
    }
    layers.into()
}

/// One paragraph gives the label and count a shared typographic baseline.
/// Equal widget bounds alone do not align fonts with different metrics.
fn counted_heading(label: &str, count: usize, size: f32) -> Element<'static, Message> {
    let spans: Vec<text::Span<'_, ()>> = vec![
        span(label.to_owned()).font(BOLD),
        span(format!(" {count}")).color(MUTED),
    ];
    rich_text(spans)
        .size(size)
        .line_height(iced::Pixels(size * 4.0 / 3.0))
        .into()
}

/// Kept outside the sidebar so it remains reachable when the sidebar is hidden.
fn sidebar_toggle(app: &App) -> Element<'_, Message> {
    button(
        row![
            text(if app.show_sidebar {
                "Hide sidebar"
            } else {
                "Show sidebar"
            })
            .size(theme::size::CAPTION),
            key("S"),
        ]
        .spacing(6)
        .align_y(Alignment::Center),
    )
    .style(theme::ghost)
    .padding([3, 8])
    .on_press(Message::ToggleSidebar)
    .into()
}

/// The undo bar for deferred actions, or a short notice.
fn status_bar(app: &App) -> Option<Element<'_, Message>> {
    let content: Element<'_, Message> = if let Some(pending) = app.pending.last() {
        let left = pending
            .due
            .saturating_duration_since(std::time::Instant::now())
            .as_secs()
            + 1;
        row![
            text(format!("{} in {left}s", pending.label)).size(theme::size::CONTROL),
            Space::new().width(16),
            button(
                row![key("Z"), text("Undo").size(theme::size::CONTROL)]
                    .spacing(6)
                    .align_y(Alignment::Center)
            )
            .style(theme::ghost)
            .padding([4, 10])
            .on_press(Message::Undo),
        ]
        .align_y(Alignment::Center)
        .into()
    } else if let Some((message, _)) = &app.toast {
        text(message.as_str()).size(theme::size::CONTROL).into()
    } else {
        return None;
    };
    Some(opaque(
        container(content).padding([10, 16]).style(theme::sheet),
    ))
}

pub fn divider(_: &iced::Theme) -> rule::Style {
    rule::Style {
        color: theme::BORDER,
        radius: 0.0.into(),
        fill_mode: rule::FillMode::Full,
        snap: true,
    }
}

pub fn dot<'a>(color: Color) -> Element<'a, Message> {
    container(Space::new())
        .width(8)
        .height(8)
        .style(theme::dot(color))
        .into()
}

/// A key hint such as `E` or `⌘K`.
pub fn key<'a>(label: &'a str) -> Element<'a, Message> {
    container(
        text(label)
            .size(theme::size::CAPTION)
            .font(MONO)
            .color(MUTED),
    )
    .padding([0, 5])
    .style(|_: &iced::Theme| container::Style {
        border: iced::Border {
            color: theme::BORDER,
            width: 1.0,
            radius: 4.0.into(),
        },
        ..container::Style::default()
    })
    .into()
}

pub fn muted<'a>(label: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(label).size(theme::size::CONTROL).color(MUTED)
}

pub fn faint<'a>(label: impl text::IntoFragment<'a>) -> text::Text<'a> {
    text(label).size(theme::size::CAPTION).color(FAINT)
}

pub fn ago(now: Timestamp, at: Timestamp) -> String {
    let seconds = (now - at).max(0);
    match seconds {
        0..60 => "now".into(),
        60..3600 => format!("{}m", seconds / 60),
        3600..86400 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86400),
    }
}

/// Shortens to one line of at most `max` characters.
pub fn line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!(
            "{}…",
            flat.chars().take(max - 1).collect::<String>().trim_end()
        )
    }
}

pub fn empty<'a>(title: &'a str, hint: &'a str) -> Element<'a, Message> {
    container(
        column![
            text(title).size(theme::size::BODY).color(MUTED),
            faint(hint).size(theme::size::CAPTION)
        ]
        .spacing(6)
        .align_x(Alignment::Center),
    )
    .width(Fill)
    .height(Length::Fill)
    .center(Fill)
    .into()
}
