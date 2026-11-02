//! Neutral panels and controls, with restrained semantic color for status
//! dots, errors, and changed code.

use crate::model::Status;
use iced::widget::{button, container, scrollable, text_editor, text_input};
use iced::{Background, Border, Color, Font, Shadow, Theme, color};

pub const WINDOW: Color = color!(0x111111);
pub const SIDEBAR: Color = color!(0x141414);
pub const SURFACE: Color = color!(0x1b1b1b);
pub const RAISED: Color = color!(0x242424);
pub const BORDER: Color = color!(0x363636);
pub const TEXT: Color = color!(0xe6e6e6);
pub const MUTED: Color = color!(0xa1a1a1);
pub const FAINT: Color = color!(0x808080);
pub const ACCENT: Color = color!(0xc7c7c7);
pub const ACCENT_SOFT: Color = color!(0x303030);
pub const AMBER: Color = color!(0xbba67f);
pub const GREEN: Color = color!(0x91ab8a);
pub const RED: Color = color!(0xc18d8d);
pub const ADDED_BG: Color = color!(0x1c241e);
pub const REMOVED_BG: Color = color!(0x291f1f);

pub const MONO: Font = Font::MONOSPACE;
pub const BOLD: Font = Font {
    weight: iced::font::Weight::Semibold,
    ..Font::DEFAULT
};

pub fn theme() -> Theme {
    Theme::custom(
        "pi-desk",
        iced::theme::Palette {
            background: WINDOW,
            text: TEXT,
            primary: ACCENT,
            success: GREEN,
            warning: AMBER,
            danger: RED,
        },
    )
}

pub fn status_color(status: &Status) -> Color {
    match status {
        Status::Queued => FAINT,
        Status::Working => ACCENT,
        Status::Question => AMBER,
        Status::Review => GREEN,
        Status::Failed { .. } => RED,
        Status::Done { .. } => FAINT,
    }
}

fn radius(value: f32) -> Border {
    Border {
        radius: value.into(),
        ..Border::default()
    }
}

pub fn window(_: &Theme) -> container::Style {
    container::Style {
        background: Some(WINDOW.into()),
        text_color: Some(TEXT),
        ..container::Style::default()
    }
}

/// Keep the panel visible behind each scrollbar, coloring only its thumb.
pub fn scrollbar(theme: &Theme, status: scrollable::Status) -> scrollable::Style {
    let mut style = scrollable::default(theme, status);
    style.vertical_rail.background = None;
    style.horizontal_rail.background = None;
    style
}

pub fn sidebar(_: &Theme) -> container::Style {
    container::Style {
        background: Some(SIDEBAR.into()),
        border: Border {
            color: BORDER,
            width: 0.0,
            radius: 0.0.into(),
        },
        ..container::Style::default()
    }
}

pub fn card(_: &Theme) -> container::Style {
    container::Style {
        background: Some(SURFACE.into()),
        border: Border {
            color: BORDER,
            width: 1.0,
            radius: 10.0.into(),
        },
        ..container::Style::default()
    }
}

pub fn sheet(_: &Theme) -> container::Style {
    container::Style {
        background: Some(SURFACE.into()),
        border: Border {
            color: BORDER,
            width: 1.0,
            radius: 12.0.into(),
        },
        shadow: Shadow {
            color: Color::from_rgba(0.0, 0.0, 0.0, 0.5),
            offset: iced::Vector::new(0.0, 12.0),
            blur_radius: 40.0,
        },
        ..container::Style::default()
    }
}

pub fn scrim(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Color::from_rgba(0.0, 0.0, 0.0, 0.55).into()),
        ..container::Style::default()
    }
}

pub fn panel(_: &Theme) -> container::Style {
    container::Style {
        background: Some(RAISED.into()),
        border: Border {
            color: BORDER,
            width: 1.0,
            radius: 8.0.into(),
        },
        ..container::Style::default()
    }
}

pub fn fill(color: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(color.into()),
        ..container::Style::default()
    }
}

pub fn dot(color: Color) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(color.into()),
        border: radius(4.0),
        ..container::Style::default()
    }
}

pub fn error_banner(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Color { a: 0.12, ..RED }.into()),
        text_color: Some(RED),
        border: Border {
            color: Color { a: 0.35, ..RED },
            width: 1.0,
            radius: 8.0.into(),
        },
        ..container::Style::default()
    }
}

/// A list row or sidebar item: transparent until hovered or selected.
pub fn row(selected: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let background = match (selected, status) {
            (true, _) => Some(Background::Color(ACCENT_SOFT)),
            (false, button::Status::Hovered | button::Status::Pressed) => {
                Some(Background::Color(RAISED))
            }
            _ => None,
        };
        button::Style {
            background,
            text_color: TEXT,
            border: radius(7.0),
            ..button::Style::default()
        }
    }
}

/// Quiet text button used for secondary actions.
pub fn ghost(_: &Theme, status: button::Status) -> button::Style {
    let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
    button::Style {
        background: hovered.then_some(Background::Color(RAISED)),
        text_color: if matches!(status, button::Status::Disabled) {
            FAINT
        } else if hovered {
            TEXT
        } else {
            MUTED
        },
        border: Border {
            color: BORDER,
            width: 1.0,
            radius: 7.0.into(),
        },
        ..button::Style::default()
    }
}

pub fn primary(_: &Theme, status: button::Status) -> button::Style {
    let background = match status {
        button::Status::Hovered | button::Status::Pressed => color!(0x3c3c3c),
        button::Status::Disabled => RAISED,
        _ => ACCENT_SOFT,
    };
    button::Style {
        background: Some(background.into()),
        text_color: if matches!(status, button::Status::Disabled) {
            FAINT
        } else {
            TEXT
        },
        border: Border {
            color: if matches!(status, button::Status::Disabled) {
                BORDER
            } else {
                color!(0x5b5b5b)
            },
            width: 1.0,
            radius: 7.0.into(),
        },
        ..button::Style::default()
    }
}

/// A numbered answer choice; the recommended one carries the accent.
pub fn choice(recommended: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: Some(if hovered { RAISED } else { SURFACE }.into()),
            text_color: TEXT,
            border: Border {
                color: if recommended {
                    Color { a: 0.6, ..ACCENT }
                } else {
                    BORDER
                },
                width: 1.0,
                radius: 8.0.into(),
            },
            ..button::Style::default()
        }
    }
}

pub fn tab(active: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
        button::Style {
            background: None,
            text_color: if active || hovered { TEXT } else { MUTED },
            border: Border {
                color: if active { ACCENT } else { Color::TRANSPARENT },
                width: 0.0,
                radius: 0.0.into(),
            },
            ..button::Style::default()
        }
    }
}

pub fn input(_: &Theme, status: text_input::Status) -> text_input::Style {
    let focused = matches!(status, text_input::Status::Focused { .. });
    text_input::Style {
        background: RAISED.into(),
        border: Border {
            color: if focused {
                Color { a: 0.7, ..ACCENT }
            } else {
                BORDER
            },
            width: 1.0,
            radius: 7.0.into(),
        },
        icon: MUTED,
        placeholder: FAINT,
        value: TEXT,
        selection: Color { a: 0.35, ..ACCENT },
    }
}

pub fn editor(_: &Theme, status: text_editor::Status) -> text_editor::Style {
    let focused = matches!(status, text_editor::Status::Focused { .. });
    text_editor::Style {
        background: RAISED.into(),
        border: Border {
            color: if focused {
                Color { a: 0.7, ..ACCENT }
            } else {
                BORDER
            },
            width: 1.0,
            radius: 8.0.into(),
        },
        placeholder: FAINT,
        value: TEXT,
        selection: Color { a: 0.35, ..ACCENT },
    }
}
