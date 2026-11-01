use iced::widget::{button, text_input};
use iced::{Background, Color};
use pi_desk::model::Priority;
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
fn controls_and_priorities_are_neutral() {
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
    for priority in [
        Priority::Urgent,
        Priority::High,
        Priority::Medium,
        Priority::Low,
    ] {
        neutral(theme::priority_color(priority));
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
