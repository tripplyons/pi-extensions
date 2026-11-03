use iced::widget::{button, container, scrollable, text_input};
use iced::{Background, Color};
use pi_desk::theme;

fn neutral(color: Color) {
    assert_eq!(color.r, color.g, "not grayscale: {color:?}");
    assert_eq!(color.g, color.b, "not grayscale: {color:?}");
}

fn luminance(color: Color) -> f32 {
    fn linear(value: f32) -> f32 {
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    }
    0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

fn readable(foreground: Color, background: Color) {
    let a = luminance(foreground);
    let b = luminance(background);
    let contrast = (a.max(b) + 0.05) / (a.min(b) + 0.05);
    assert!(contrast >= 4.5, "text contrast is only {contrast:.2}:1");
}

#[test]
fn desktop_and_snapshots_share_a_small_type_scale_and_font_family() {
    let settings = theme::settings();
    assert_eq!(settings.default_font, theme::SANS);
    assert_eq!(settings.default_text_size.0, theme::size::CONTROL);
    assert_eq!(theme::BOLD.family, theme::SANS.family);
    assert_eq!(theme::BOLD.weight, iced::font::Weight::Semibold);
    assert_ne!(theme::MONO.family, theme::SANS.family);
    assert_eq!(
        [
            theme::size::CAPTION,
            theme::size::CONTROL,
            theme::size::BODY,
            theme::size::HEADING,
            theme::size::TITLE,
        ],
        [12.0, 13.0, 14.0, 16.0, 18.0]
    );
}

#[cfg(target_os = "macos")]
#[test]
fn the_native_sans_family_is_available_to_the_renderer() {
    let mut system = iced::advanced::graphics::text::font_system()
        .write()
        .unwrap();
    let iced::font::Family::Name(name) = theme::SANS.family else {
        panic!("expected a named macOS system font")
    };
    assert!(
        system
            .raw()
            .db()
            .faces()
            .any(|face| face.families.iter().any(|(family, _)| family == name))
    );
}

#[test]
fn controls_are_neutral() {
    let theme = theme::theme();
    for color in [
        theme::WINDOW,
        theme::SIDEBAR,
        theme::SURFACE,
        theme::RAISED,
        theme::BORDER,
        theme::TEXT,
        theme::MUTED,
        theme::FAINT,
        theme::ACCENT,
        theme::ACCENT_SOFT,
    ] {
        neutral(color);
    }
    for status in [
        button::Status::Active,
        button::Status::Hovered,
        button::Status::Pressed,
        button::Status::Disabled,
    ] {
        for style in [
            theme::primary(&theme, status),
            theme::ghost(&theme, status),
            theme::row(true)(&theme, status),
            theme::choice(true)(&theme, status),
            theme::tab(true)(&theme, status),
        ] {
            neutral(style.text_color);
            neutral(style.border.color);
            if let Some(Background::Color(color)) = style.background {
                neutral(color);
            }
        }
    }
    let input = theme::input(&theme, text_input::Status::Focused { is_hovered: false });
    neutral(input.border.color);
    neutral(input.selection);
}

#[test]
fn scrollbar_tracks_stay_transparent_and_preserve_thumb_feedback() {
    let theme = theme::theme();
    let flags = [(false, false), (true, false), (false, true), (true, true)];
    for (horizontal_disabled, vertical_disabled) in flags {
        for (horizontal_interacted, vertical_interacted) in flags {
            for status in [
                scrollable::Status::Active {
                    is_horizontal_scrollbar_disabled: horizontal_disabled,
                    is_vertical_scrollbar_disabled: vertical_disabled,
                },
                scrollable::Status::Hovered {
                    is_horizontal_scrollbar_hovered: horizontal_interacted,
                    is_vertical_scrollbar_hovered: vertical_interacted,
                    is_horizontal_scrollbar_disabled: horizontal_disabled,
                    is_vertical_scrollbar_disabled: vertical_disabled,
                },
                scrollable::Status::Dragged {
                    is_horizontal_scrollbar_dragged: horizontal_interacted,
                    is_vertical_scrollbar_dragged: vertical_interacted,
                    is_horizontal_scrollbar_disabled: horizontal_disabled,
                    is_vertical_scrollbar_disabled: vertical_disabled,
                },
            ] {
                let style = theme::scrollbar(&theme, status);
                let default = scrollable::default(&theme, status);
                assert_eq!(style.container, container::Style::default());
                assert_eq!(style.gap, None);
                for (rail, default_rail) in [
                    (style.horizontal_rail, default.horizontal_rail),
                    (style.vertical_rail, default.vertical_rail),
                ] {
                    assert_eq!(rail.background, None, "painted track for {status:?}");
                    assert_eq!(rail.border, default_rail.border);
                    assert_eq!(rail.scroller, default_rail.scroller);
                    let Background::Color(color) = rail.scroller.background else {
                        panic!("thumb must have a solid color")
                    };
                    assert!(color.a > 0.0, "thumb must remain visible");
                }
            }
        }
    }
}

#[test]
fn body_secondary_and_action_text_remain_readable() {
    for background in [
        theme::WINDOW,
        theme::SIDEBAR,
        theme::SURFACE,
        theme::RAISED,
        theme::ACCENT_SOFT,
    ] {
        readable(theme::TEXT, background);
        readable(theme::MUTED, background);
        readable(theme::FAINT, background);
    }
    let theme = theme::theme();
    for status in [button::Status::Active, button::Status::Hovered] {
        let style = theme::primary(&theme, status);
        let Some(Background::Color(background)) = style.background else {
            panic!("missing button fill")
        };
        assert!(luminance(background) < 0.1, "primary fill must stay dark");
        readable(style.text_color, background);
    }
}
