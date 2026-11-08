//! Window layout: sidebar, row list, and detail pane, with focus mode, the
//! board, and overlays on top.

pub mod board;
mod card;
mod detail;
mod list;
mod overlays;
mod session;
mod sidebar;

use crate::app::{App, Message};
use crate::icon::{Icon, KeyPart};
use crate::model::Timestamp;
use crate::theme::{self, P, size};
use rune::{Color, Cx, El, ScrollSpec, Span, Transition, Tx, col, el, rich, row, text};

thread_local! {
    /// Menus and popups built during a view, mounted above everything.
    static LAYER: std::cell::RefCell<Vec<El>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Builds with the overlay layer, for rune-kit controls with popups.
pub fn with_layer<R>(build: impl FnOnce(&mut Vec<El>) -> R) -> R {
    LAYER.with(|layer| build(&mut layer.borrow_mut()))
}

/// The key of a task's row in the list, for scrolling it into view.
pub fn row_key(id: &str) -> String {
    format!("task-{id}")
}

/// A press handler that sends `message`.
pub fn send(message: Message) -> impl Fn(&mut App, &mut Tx) + 'static {
    move |app: &mut App, tx: &mut Tx| app.dispatch(message.clone(), tx)
}

pub fn root(app: &App, _cx: &mut Cx<App>) -> El {
    LAYER.with(|layer| layer.borrow_mut().clear());
    let window = window(app);
    let layer = LAYER.with(|layer| std::mem::take(&mut *layer.borrow_mut()));
    rune_kit::root(window, layer)
}

fn window(app: &App) -> El {
    let body = if app.focus && app.current().is_some() {
        row()
            .key("focus")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .justify_center()
            .child(
                col()
                    .key("focus-column")
                    .w_full()
                    .max_w(900.0)
                    .h_full()
                    .px(32.0)
                    .py(24.0)
                    .gap(16.0)
                    .child(card::view(app))
                    .child(detail::view(app)),
            )
    } else {
        let mut panes = row().key("panes").w_full().grow(1.0).min_h(0.0);
        if app.show_sidebar {
            panes = panes.child(sidebar::view(app)).child(vrule("sidebar-rule"));
        }
        if app.board {
            panes.child(board::view(app))
        } else {
            panes
                .child(list::view(app))
                .child(vrule("list-rule"))
                .child(detail::pane(app))
        }
    };
    let mut page = col().key("page").w_full().h_full().fill(P.window);
    if let Some(error) = &app.error {
        page = page.child(
            row()
                .key("error-banner")
                .w_full()
                .px(14.0)
                .py(8.0)
                .gap(12.0)
                .center_y()
                .fill(P.red.alpha(0.16))
                .border_sides([0.0, 0.0, 1.0, 0.0], P.red.alpha(0.35))
                .transition(Transition::opacity())
                .child(
                    label(error, size::CONTROL, P.text)
                        .wrap()
                        .grow(1.0)
                        .shrink(),
                )
                .child(ghost("dismiss-error", "Dismiss", &[], Message::DismissError)),
        );
    }
    page = page.child(body);

    // UI zoom: lay the page out at the zoomed size, then scale it to fill.
    let zoom = app.scale_factor();
    let page = match app.viewport {
        Some((w, h)) if zoom != 1.0 => page
            .w(w / zoom)
            .h(h / zoom)
            .scale(zoom)
            .origin(0.0, 0.0)
            .absolute(0.0, 0.0),
        _ => page,
    };
    let mut window = el()
        .key("window")
        .w_full()
        .h_full()
        .fill(P.window)
        .on_layout(|app: &mut App, rect: [f32; 4]| {
            let size = (rect[2], rect[3]);
            if app.viewport != Some(size) {
                app.viewport = Some(size);
            }
        })
        .on_drop_files(|app: &mut App, paths: &[std::path::PathBuf], tx: &mut Tx| {
            for path in paths {
                app.dispatch(Message::FileDropped(path.clone()), tx);
            }
        })
        .child(page);
    if let Some(bar) = status_bar(app) {
        window = window.child(
            row()
                .key("status-layer")
                .pin(Some(0.0), None, Some(0.0), Some(18.0))
                .justify_center()
                .child(bar),
        );
    }
    if let Some(sheet) = overlays::view(app) {
        window = window.child(
            col()
                .key("scrim")
                .absolute(0.0, 0.0)
                .w_full()
                .h_full()
                .fill(P.scrim)
                .items_center()
                .pt(90.0)
                .transition(Transition::opacity())
                .on_press_tx(send(Message::CloseOverlay))
                .child(sheet),
        );
    }
    window
}

/// A vertical hairline between panes.
pub fn vrule(key: &str) -> El {
    el().key(key).w(1.0).h_full().fill(P.border_soft)
}

/// A horizontal hairline.
pub fn hrule(key: &str) -> El {
    el().key(key).h(1.0).w_full().fill(P.border_soft)
}

/// Text in the interface face.
pub fn label(content: impl Into<String>, size: f32, color: Color) -> El {
    text(content).font(theme::sans(size)).color(color)
}

pub fn strong(content: impl Into<String>, size: f32, color: Color) -> El {
    text(content).font(theme::bold(size)).color(color)
}

pub fn muted(content: impl Into<String>) -> El {
    label(content, size::CONTROL, P.muted)
}

pub fn faint(content: impl Into<String>) -> El {
    label(content, size::CAPTION, P.faint)
}

pub fn mono(content: impl Into<String>, size: f32, color: Color) -> El {
    text(content).font(theme::mono(size)).color(color)
}

/// One paragraph gives the label and count a shared baseline.
pub fn counted_heading(label: &str, count: usize, size: f32) -> El {
    let content = format!("{label} {count}");
    let spans = vec![
        Span::new(0, label.len()).weight(theme::SEMIBOLD).color(P.text),
        Span::new(label.len(), content.len()).color(P.muted),
    ];
    rich(content, spans).font(theme::sans(size)).color(P.text)
}

pub fn icon(glyph: Icon, size: f32, color: Color) -> El {
    rune::icon(glyph.glyph(), size).color(color)
}

/// A key hint with one text key, such as `E` or `Esc`.
pub fn key(label: &str) -> El {
    keys(&[KeyPart::Text(label)])
}

/// A key hint whose modifiers and arrows draw as icons.
pub fn keys(parts: &[KeyPart<'_>]) -> El {
    let mut chip = row()
        .gap(2.0)
        .center_y()
        .h(18.0)
        .px(5.0)
        .radius(4.0)
        .fill(P.raised.alpha(0.6))
        .border(1.0, P.border);
    for (index, part) in parts.iter().enumerate() {
        chip = chip.child(match *part {
            KeyPart::Text(label) => mono(label, size::CAPTION - 1.0, P.muted).key(format!("k{index}")),
            KeyPart::Icon(glyph) => icon(glyph, 11.0, P.muted).key(format!("k{index}")),
        });
    }
    chip
}

/// A quiet button: a label and optional key hint on a hover fill.
pub fn ghost(key: &str, label_text: &str, hint: &[KeyPart<'static>], message: Message) -> El {
    let mut button = row()
        .key(key)
        .gap(6.0)
        .center_y()
        .px(10.0)
        .h(28.0)
        .radius(6.0)
        .border(1.0, P.border)
        .hover(P.hover)
        .press(P.press)
        .motion(theme::SNAPPY)
        .label(label_text)
        .role("button")
        .on_press_tx(send(message))
        .child(label(label_text, size::CONTROL, P.text));
    if !hint.is_empty() {
        button = button.child(keys(hint));
    }
    button
}

/// The main action of a sheet: a raised neutral fill, or a red one for
/// destructive actions.
pub fn primary(
    key: &str,
    label_text: &str,
    hint: &[KeyPart<'static>],
    message: Option<Message>,
    danger: bool,
) -> El {
    let (fill, edge, hover) = if danger {
        (P.red.alpha(0.22), P.red.alpha(0.55), P.red.alpha(0.32))
    } else {
        (P.accent_soft, P.border_strong, theme::srgb(0.235, 0.235, 0.235))
    };
    let mut button = row()
        .key(key)
        .gap(6.0)
        .center_y()
        .px(12.0)
        .h(28.0)
        .radius(7.0)
        .fill(fill)
        .border(1.0, edge)
        .label(label_text)
        .role("button")
        .child(text(label_text).font(theme::medium(size::CONTROL)).color(P.text));
    if !hint.is_empty() {
        button = button.child(keys(hint));
    }
    match message {
        Some(message) => button
            .hover(hover)
            .press(P.press)
            .motion(theme::SNAPPY)
            .on_press_tx(send(message)),
        None => button.opacity(0.45),
    }
}

/// A selectable row's background: raised when selected, a hover tint otherwise.
pub fn selectable(element: El, selected: bool) -> El {
    element
        .radius(8.0)
        .fill(if selected { P.selected } else { Color::TRANSPARENT })
        .hover(if selected { Color::TRANSPARENT } else { P.hover })
        .press(P.press)
        .motion(theme::SNAPPY)
}

/// A small rounded label, such as a status.
pub fn chip(content: impl Into<String>, color: Color) -> El {
    row()
        .h(18.0)
        .px(6.0)
        .center_y()
        .radius(9.0)
        .fill(color.alpha(0.14))
        .child(text(content).font(theme::medium(size::CAPTION - 1.0)).color(color))
}

/// A vertical scroll area that takes the rest of its parent's height.
pub fn scroller(key: &str, content: El) -> El {
    col()
        .key(key)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .scroll(ScrollSpec { stick_bottom: false })
        .scroll_edge_fade(12.0)
        .child(content)
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

pub fn empty(key: &str, title: &str, hint: &str) -> El {
    let mut column = col()
        .key(key)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .center()
        .gap(6.0)
        .child(label(title, size::BODY, P.muted));
    if !hint.is_empty() {
        column = column.child(faint(hint));
    }
    column
}

/// Kept outside the sidebar so it stays reachable when the sidebar is hidden.
fn sidebar_toggle(app: &App) -> El {
    ghost(
        "sidebar-toggle",
        if app.show_sidebar {
            "Hide sidebar"
        } else {
            "Show sidebar"
        },
        &[KeyPart::Text("S")],
        Message::ToggleSidebar,
    )
}

/// The undo bar for deferred actions, or a short notice.
fn status_bar(app: &App) -> Option<El> {
    let bar = row()
        .key("status-bar")
        .gap(16.0)
        .center_y()
        .px(16.0)
        .py(10.0)
        .radius(10.0)
        .fill(P.raised)
        .border(1.0, P.border)
        .shadow(8.0, 24.0, P.shadow)
        .transition(Transition::offset(0.0, 12.0).combined(Transition::opacity()));
    if let Some(pending) = app.pending.last() {
        let left = pending
            .due
            .saturating_duration_since(std::time::Instant::now())
            .as_secs()
            + 1;
        Some(
            bar.child(label(
                format!("{} in {left}s", pending.label),
                size::CONTROL,
                P.text,
            ))
            .child(ghost("undo", "Undo", &[KeyPart::Text("Z")], Message::Undo)),
        )
    } else {
        app.toast
            .as_ref()
            .map(|(message, _)| bar.child(label(message, size::CONTROL, P.text)))
    }
}
