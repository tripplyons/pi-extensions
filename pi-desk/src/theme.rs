//! Neutral panels and controls, with restrained semantic color for errors,
//! changed code, goals, and swarm activity.
//!
//! Rune colors are linear; every token here is authored in sRGB hex.

use rune::{Color, Family, Spring, TextStyle};
use std::sync::LazyLock;

/// An sRGB color from 0..1 channels.
pub fn srgb(r: f32, g: f32, b: f32) -> Color {
    use rune::color::srgb_decode;
    Color {
        r: srgb_decode(r),
        g: srgb_decode(g),
        b: srgb_decode(b),
        a: 1.0,
    }
}

fn hex(value: &str) -> Color {
    rune::color::hex(value).expect("valid theme color")
}

pub struct Palette {
    pub window: Color,
    pub sidebar: Color,
    pub surface: Color,
    pub raised: Color,
    pub selected: Color,
    pub hover: Color,
    pub press: Color,
    pub border: Color,
    pub border_soft: Color,
    pub border_strong: Color,
    pub text: Color,
    pub muted: Color,
    pub faint: Color,
    pub accent: Color,
    pub accent_soft: Color,
    pub amber: Color,
    pub green: Color,
    pub red: Color,
    pub added_bg: Color,
    pub removed_bg: Color,
    pub hunk_bg: Color,
    pub scrim: Color,
    pub shadow: Color,
    pub selection: Color,
    /// The vim normal-mode block cursor: stronger than a visual selection.
    pub block_cursor: Color,
}

pub static P: LazyLock<Palette> = LazyLock::new(|| Palette {
    window: hex("#111111"),
    sidebar: hex("#141414"),
    surface: hex("#1a1a1a"),
    raised: hex("#232323"),
    selected: hex("#2b2b2b"),
    hover: hex("#ffffff0b"),
    press: hex("#ffffff14"),
    border: hex("#333333"),
    border_soft: hex("#262626"),
    border_strong: hex("#4a4a4a"),
    text: hex("#e6e6e6"),
    muted: hex("#b0b0b0"),
    faint: hex("#999999"),
    accent: hex("#c7c7c7"),
    accent_soft: hex("#303030"),
    amber: hex("#c4ad83"),
    green: hex("#91ab8a"),
    red: hex("#c18d8d"),
    added_bg: hex("#1c241e"),
    removed_bg: hex("#291f1f"),
    hunk_bg: hex("#1d1d1d"),
    scrim: hex("#0000008c"),
    shadow: hex("#00000080"),
    selection: hex("#c7c7c759"),
    block_cursor: hex("#c7c7c780"),
});

/// The shared type scale: captions, controls, body text, headings, titles.
pub mod size {
    pub const CAPTION: f32 = 12.0;
    pub const CONTROL: f32 = 13.0;
    pub const BODY: f32 = 14.0;
    pub const HEADING: f32 = 16.0;
    pub const TITLE: f32 = 18.0;
}

pub const REGULAR: f32 = 400.0;
pub const MEDIUM: f32 = 500.0;
pub const SEMIBOLD: f32 = 600.0;

/// Interface text at `size`, on a 1.5 line for body copy and 4/3 for headings.
pub const fn sans(size: f32) -> TextStyle {
    let mut style = TextStyle::new(size, REGULAR);
    style.line_height = if size >= size::HEADING {
        size * 4.0 / 3.0
    } else {
        (size * 1.5 * 2.0) as i32 as f32 / 2.0
    };
    style
}

/// Interface text with a tight line, for dense rows and cards.
pub const fn tight(size: f32) -> TextStyle {
    let mut style = sans(size);
    style.line_height = (size * 1.35 + 0.5) as i32 as f32;
    style
}

pub const fn medium(size: f32) -> TextStyle {
    let mut style = sans(size);
    style.weight = MEDIUM;
    style
}

pub const fn bold(size: f32) -> TextStyle {
    let mut style = sans(size);
    style.weight = SEMIBOLD;
    style
}

/// Code, paths, and key hints: the platform monospace (SF Mono on macOS).
pub const fn mono(size: f32) -> TextStyle {
    let mut style = sans(size);
    style.family = Family::SystemMono;
    style
}

/// Quick, unbouncy motion for hover, selection, and disclosure.
pub const SNAPPY: Spring = rune::tok::motion::SNAPPY;

/// The shared kit, built once.
pub static KIT: LazyLock<rune_kit::Kit> = LazyLock::new(kit);

/// The rune-kit tokens for fields, menus, and Markdown, derived from [`P`].
pub fn kit() -> rune_kit::Kit {
    let p = &*P;
    let mut kit = rune_kit::Kit::from_palette(rune_kit::PaletteSeed {
        bg: p.surface,
        fg: p.text,
        accent: p.accent,
    });
    kit.c.text_base = p.text;
    kit.c.text_strong = p.text;
    kit.c.text_muted = p.muted;
    kit.c.text_faint = p.faint;
    kit.c.border_base = p.border;
    kit.c.border_weak = p.border_soft;
    kit.c.border_strong = p.border_strong;
    kit.c.border_focus = p.border_strong;
    kit
}

/// Transcript Markdown on the body scale, with inline code on a raised chip.
pub fn markdown() -> rune_kit::MarkdownStyle {
    let p = &*P;
    rune_kit::MarkdownStyle::from_kit(&KIT)
        .text(p.text)
        .muted(p.muted)
        .link(p.text)
        .link_underline(p.faint)
        .inline_code_bg(p.raised)
        .code_block(p.sidebar, p.border_soft)
        .rule(p.border)
        .quote_rule(p.border_strong)
        .body_font(sans(size::BODY))
        .heading_font(1, bold(size::TITLE))
        .heading_font(2, bold(size::HEADING))
        .heading_font(3, bold(size::BODY))
        .heading_font(4, bold(size::BODY))
        .code_block_font(mono(size::CONTROL))
        .strong_weight(SEMIBOLD)
}
