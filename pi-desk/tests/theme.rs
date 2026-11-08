use pi_desk::theme::{self, P, size};
use rune::{Color, Family};

/// sRGB channels in 0..1, as authored.
fn srgb(color: Color) -> [f32; 3] {
    use rune::color::srgb_encode;
    [srgb_encode(color.r), srgb_encode(color.g), srgb_encode(color.b)]
}

fn neutral(color: Color) {
    let [r, g, b] = srgb(color);
    assert!((r - g).abs() < 1e-3 && (g - b).abs() < 1e-3, "not grayscale: {color:?}");
}

/// WCAG relative luminance; Rune colors are already linear.
fn luminance(color: Color) -> f32 {
    0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

fn readable(foreground: Color, background: Color) {
    let a = luminance(foreground);
    let b = luminance(background);
    let contrast = (a.max(b) + 0.05) / (a.min(b) + 0.05);
    assert!(contrast >= 4.5, "text contrast is only {contrast:.2}:1");
}

#[test]
fn text_uses_a_small_type_scale_in_one_family_with_a_separate_code_face() {
    assert_eq!(theme::sans(size::BODY).family, theme::bold(size::BODY).family);
    assert_eq!(theme::mono(size::BODY).family, Family::SystemMono);
    assert_ne!(theme::mono(size::BODY).family, theme::sans(size::BODY).family);
    let scale = [
        size::CAPTION,
        size::CONTROL,
        size::BODY,
        size::HEADING,
        size::TITLE,
    ];
    assert!(scale.windows(2).all(|pair| pair[0] < pair[1]));
}

#[test]
fn panels_and_controls_are_neutral() {
    for color in [
        P.window,
        P.sidebar,
        P.surface,
        P.raised,
        P.selected,
        P.border,
        P.border_soft,
        P.border_strong,
        P.text,
        P.muted,
        P.faint,
        P.accent,
        P.accent_soft,
    ] {
        neutral(color);
    }
}

#[test]
fn body_secondary_and_action_text_remain_readable() {
    for background in [P.window, P.sidebar, P.surface, P.raised, P.accent_soft] {
        readable(P.text, background);
        readable(P.muted, background);
        readable(P.faint, background);
    }
    // The primary button keeps a dark fill under light text.
    assert!(luminance(P.accent_soft) < 0.1, "primary fill must stay dark");
    for semantic in [P.amber, P.green, P.red] {
        readable(semantic, P.surface);
    }
}
