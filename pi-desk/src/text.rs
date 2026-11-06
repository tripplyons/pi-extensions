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

/// Markdown as plain text for one-line previews: drops heading, quote, and
/// list markers, code fences, emphasis and code marks, and link targets.
pub fn plain(markdown: &str) -> String {
    let mut out = Vec::new();
    for line in markdown.lines() {
        let line = line.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            continue;
        }
        let line = line.trim_start_matches(['#', '>']).trim_start();
        let line = ["- ", "* ", "+ "]
            .iter()
            .find_map(|marker| line.strip_prefix(marker))
            .unwrap_or(line);
        out.push(strip_inline(line));
    }
    out.join("\n")
}

fn strip_inline(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(c) = rest.chars().next() {
        // [text](target) keeps only the text.
        if c == '['
            && let Some(close) = rest.find("](")
            && let Some(end) = rest[close..].find(')')
        {
            out.push_str(&rest[1..close]);
            rest = &rest[close + end + 1..];
            continue;
        }
        if rest.starts_with("**") || rest.starts_with("__") {
            rest = &rest[2..];
            continue;
        }
        if c == '`' {
            rest = &rest[1..];
            continue;
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_drops_markdown_syntax() {
        let markdown = "# Title\n\nRead the [guide](https://x.y/z) and **check** `main.rs`.\n```rust\nfn x() {}\n```\n- one\n> quoted";
        assert_eq!(
            one_line(&plain(markdown), 200),
            "Title Read the guide and check main.rs. fn x() {} one quoted"
        );
    }
}
