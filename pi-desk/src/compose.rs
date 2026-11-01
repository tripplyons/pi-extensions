//! Turns composer text into tasks. A bulleted or numbered list makes one task
//! per item; any other text makes one task. Text before the first item is
//! shared context and goes into every task from that list.

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
    let line = line.trim_start_matches('#').trim();
    if line.chars().count() <= 80 {
        line.to_string()
    } else {
        format!("{}…", line.chars().take(79).collect::<String>().trim_end())
    }
}

pub fn split(text: &str) -> Vec<Draft> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let mut context: Vec<&str> = Vec::new();
    let mut items: Vec<Vec<String>> = Vec::new();
    for line in text.lines() {
        if let Some(rest) = list_item(line) {
            items.push(vec![rest.trim().to_string()]);
        } else if let Some(item) = items.last_mut() {
            // Indented or wrapped lines continue the current item.
            if !line.trim().is_empty() {
                item.push(line.trim().to_string());
            }
        } else {
            context.push(line);
        }
    }
    let items: Vec<String> = items
        .into_iter()
        .map(|item| item.join("\n"))
        .filter(|item| !item.is_empty())
        .collect();
    if items.len() < 2 {
        return vec![Draft {
            title: title(text),
            prompt: text.to_string(),
        }];
    }
    let context = context.join("\n").trim().to_string();
    items
        .into_iter()
        .map(|item| Draft {
            title: title(&item),
            prompt: if context.is_empty() {
                item
            } else {
                format!("{context}\n\n{item}")
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_one_task_even_with_paragraphs() {
        let drafts = split("Fix the login bug.\n\nIt fails when the password has a space.");
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].title, "Fix the login bug.");
        assert!(drafts[0].prompt.ends_with("space."));
    }

    #[test]
    fn lists_make_one_task_per_item_with_shared_context() {
        let drafts = split(
            "In the API crate:\n- Add retries\n  with backoff\n2. Remove the dead flag\n* [ ] Log slow queries",
        );
        assert_eq!(
            drafts,
            vec![
                Draft {
                    title: "Add retries".into(),
                    prompt: "In the API crate:\n\nAdd retries\nwith backoff".into()
                },
                Draft {
                    title: "Remove the dead flag".into(),
                    prompt: "In the API crate:\n\nRemove the dead flag".into()
                },
                Draft {
                    title: "Log slow queries".into(),
                    prompt: "In the API crate:\n\nLog slow queries".into()
                },
            ]
        );
    }

    #[test]
    fn a_single_item_list_and_blank_text_are_handled() {
        assert_eq!(split("- just one").len(), 1);
        assert!(split("  \n ").is_empty());
    }

    #[test]
    fn long_titles_are_shortened() {
        let title = title(&"word ".repeat(40));
        assert!(title.chars().count() <= 80);
        assert!(title.ends_with('…'));
    }
}
