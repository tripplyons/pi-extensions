//! Turns composer text into one task. The whole text is the prompt, and the
//! first non-empty line, without heading or list markers, is the title.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub title: String,
    pub prompt: String,
}

fn list_item(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if line.len() - trimmed.len() > 1 {
        return None;
    }
    for marker in ["- [ ] ", "- [x] ", "* [ ] ", "- ", "* ", "+ ", "• "] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            return Some(rest);
        }
    }
    let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && digits < 4 {
        let rest = &trimmed[digits..];
        for marker in [". ", ") "] {
            if let Some(rest) = rest.strip_prefix(marker) {
                return Some(rest);
            }
        }
    }
    None
}

pub fn title(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Untitled");
    let line = list_item(line).unwrap_or(line);
    crate::text::one_line(line.trim_start_matches('#').trim(), 80)
}

pub fn draft(text: &str) -> Option<Draft> {
    let text = text.trim();
    (!text.is_empty()).then(|| Draft {
        title: title(text),
        prompt: text.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_one_task_even_with_paragraphs() {
        let draft = draft("Fix the login bug.\n\nIt fails when the password has a space.").unwrap();
        assert_eq!(draft.title, "Fix the login bug.");
        assert!(draft.prompt.ends_with("space."));
    }

    #[test]
    fn a_list_is_one_task_with_the_whole_text() {
        let text = "In the API crate:\n- Add retries\n  with backoff\n2. Remove the dead flag";
        assert_eq!(
            draft(text),
            Some(Draft {
                title: "In the API crate:".into(),
                prompt: text.into(),
            })
        );
        let list = "- [ ] Add retries\n- Remove the dead flag";
        assert_eq!(
            draft(list),
            Some(Draft {
                title: "Add retries".into(),
                prompt: list.into(),
            })
        );
    }

    #[test]
    fn blank_text_files_nothing() {
        assert_eq!(draft("  \n "), None);
        assert_eq!(draft("# Heading").unwrap().title, "Heading");
    }

    #[test]
    fn long_titles_are_shortened() {
        let title = title(&"word ".repeat(40));
        assert!(title.chars().count() <= 80);
        assert!(title.ends_with('…'));
    }
}
