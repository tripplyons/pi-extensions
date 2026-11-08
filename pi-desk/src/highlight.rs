//! Syntax colors for diff lines, computed once when a diff loads.

use crate::git::{DiffLine, LineKind};
use rune::Color;
use std::ops::Range;
use std::sync::OnceLock;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::{SyntaxReference, SyntaxSet};

/// Diff lines shown per file. Only these get syntax colors.
pub const SHOWN_LINES: usize = 4000;

pub type Spans = Vec<(Range<usize>, Option<Color>)>;

fn syntaxes() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn theme() -> &'static Theme {
    static THEME: OnceLock<Theme> = OnceLock::new();
    THEME.get_or_init(|| {
        let mut themes = ThemeSet::load_defaults();
        themes
            .themes
            .remove("base16-ocean.dark")
            .expect("syntect bundles base16-ocean.dark")
    })
}

/// Preserve token luminance while reducing color competition with diff markers.
fn subdued(r: u8, g: u8, b: u8) -> Color {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let mix = |c: f32| (gray + (c - gray) * 0.35).clamp(0.0, 1.0);
    crate::theme::srgb(mix(r), mix(g), mix(b))
}

fn syntax_for(path: &str) -> Option<&'static SyntaxReference> {
    let set = syntaxes();
    let name = path.rsplit('/').next().unwrap_or(path);
    let token = name
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or(name);
    set.find_syntax_by_extension(token)
        .or_else(|| set.find_syntax_by_token(token))
        .filter(|syntax| syntax.name != "Plain Text")
}

/// Colored ranges for each line. Hunk and meta lines get none, and files with
/// no known syntax get none.
pub fn diff_lines(path: &str, lines: &[DiffLine]) -> Vec<Spans> {
    let Some(syntax) = syntax_for(path) else {
        return vec![Vec::new(); lines.len().min(SHOWN_LINES)];
    };
    let mut highlighter = HighlightLines::new(syntax, theme());
    lines
        .iter()
        .take(SHOWN_LINES)
        .map(|line| {
            if matches!(line.kind, LineKind::Hunk | LineKind::Meta) {
                if line.kind == LineKind::Hunk {
                    highlighter = HighlightLines::new(syntax, theme());
                }
                return Vec::new();
            }
            let text = format!("{}\n", line.text);
            let Ok(regions) = highlighter.highlight_line(&text, syntaxes()) else {
                return Vec::new();
            };
            let mut spans = Spans::new();
            let mut start = 0;
            for (style, piece) in regions {
                let end = (start + piece.len()).min(line.text.len());
                if end > start {
                    let f = style.foreground;
                    spans.push((start..end, Some(subdued(f.r, f.g, f.b))));
                }
                start += piece.len();
            }
            spans
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(kind: LineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            text: text.into(),
        }
    }

    #[test]
    fn known_files_get_colored_ranges_that_cover_each_line() {
        let lines = [
            line(LineKind::Hunk, "@@ -1 +1 @@"),
            line(LineKind::Added, "fn main() { let x = 1; }"),
        ];
        let spans = diff_lines("src/main.rs", &lines);
        assert!(spans[0].is_empty(), "hunk headers are not colored");
        let covered: usize = spans[1].iter().map(|(range, _)| range.len()).sum();
        assert_eq!(covered, lines[1].text.len());
        let colors: std::collections::HashSet<String> = spans[1]
            .iter()
            .map(|(_, color)| format!("{color:?}"))
            .collect();
        assert!(colors.len() > 1, "keywords and names differ: {colors:?}");
    }

    #[test]
    fn unknown_files_are_left_plain() {
        let spans = diff_lines("notes.unknownext", &[line(LineKind::Added, "hello")]);
        assert_eq!(spans, vec![Vec::new()]);
    }
}
