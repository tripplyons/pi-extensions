//! Plain-text helpers shared by saved state and views.

/// Collapses whitespace to single spaces and shortens to at most `max`
/// characters, ending with `…` when cut.
pub fn one_line(text: &str, max: usize) -> String {
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
