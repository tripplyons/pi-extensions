//! Syntax colors for diff lines, computed once when a diff loads.

use crate::git::{DiffLine, LineKind};
use iced::Color;
use iced::highlighter::{Settings, Stream, Theme};
use std::ops::Range;

/// Diff lines shown per file. Only these get syntax colors.
pub const SHOWN_LINES: usize = 4000;

pub type Spans = Vec<(Range<usize>, Option<Color>)>;

/// Preserve token luminance while reducing color competition with diff markers.
fn subdued(color: Color) -> Color {
    let gray = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    Color {
        r: gray + (color.r - gray) * 0.35,
        g: gray + (color.g - gray) * 0.35,
        b: gray + (color.b - gray) * 0.35,
        ..color
    }
}

/// Colored ranges for each line. Hunk and meta lines get none.
pub fn diff_lines(path: &str, lines: &[DiffLine]) -> Vec<Spans> {
    let token = path
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or(path)
        .to_string();
    let mut stream = Stream::new(&Settings {
        theme: Theme::Base16Ocean,
        token,
    });
    lines
        .iter()
        .take(SHOWN_LINES)
        .map(|line| {
            if matches!(line.kind, LineKind::Hunk | LineKind::Meta) {
                if line.kind == LineKind::Hunk {
                    stream.reset();
                }
                return Vec::new();
            }
            let spans: Spans = stream
                .highlight_line(&line.text)
                .map(|(range, highlight)| (range, highlight.color().map(subdued)))
                .collect();
            stream.commit();
            spans
        })
        .collect()
}
