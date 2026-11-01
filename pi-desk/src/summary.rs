//! The two summary lines an agent ends with, and the system prompt that asks
//! for them.

use crate::model::Summary;

pub const SYSTEM_PROMPT: &str = "\
You are running inside pi-desk, a desktop inbox for parallel Pi agents. You work alone in a \
dedicated git worktree on your own branch. The user is not watching: they review your diff later, \
and pi-desk squash-merges your branch when they approve. You may commit; pi-desk commits anything \
left uncommitted before it merges.

When you need a decision, call ask_user with short choices and set recommended to the number of \
the choice you recommend. Do not stop to ask in plain text.

End every final message with exactly these two lines:
Did: <what you did, in one sentence>
Needs: <what you need from the user, in one sentence, or \"Review and merge\">";

fn field<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let line = line.trim().trim_start_matches(['-', '*', '>']).trim();
    let line = line.strip_prefix("**").unwrap_or(line);
    let rest = line.strip_prefix(name)?;
    let rest = rest
        .strip_prefix(':')
        .or_else(|| rest.strip_prefix("**:"))?;
    let rest = rest.trim().trim_start_matches("**").trim();
    (!rest.is_empty()).then_some(rest)
}

fn shorten(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        text
    } else {
        format!(
            "{}…",
            text.chars().take(max - 1).collect::<String>().trim_end()
        )
    }
}

/// Uses the last `Did:` and `Needs:` lines. Without them, the first line of
/// the message stands in for what the agent did.
pub fn parse(text: &str) -> Option<Summary> {
    let mut did = None;
    let mut needs = None;
    for line in text.lines() {
        if let Some(value) = field(line, "Did") {
            did = Some(value);
        } else if let Some(value) = field(line, "Needs") {
            needs = Some(value);
        }
    }
    let did = match did {
        Some(did) => did.to_string(),
        None => text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())?
            .trim_start_matches('#')
            .trim()
            .to_string(),
    };
    Some(Summary {
        did: shorten(&did, 200),
        needs: shorten(needs.unwrap_or(""), 200),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_did_and_needs_lines_win() {
        let text = "Working notes.\nDid: draft\n\nDone.\n**Did:** Added retries to the client.\n**Needs:** Review and merge";
        assert_eq!(
            parse(text),
            Some(Summary {
                did: "Added retries to the client.".into(),
                needs: "Review and merge".into()
            })
        );
    }

    #[test]
    fn missing_fields_fall_back_to_the_first_line() {
        assert_eq!(
            parse("## Fixed the flaky test\nMore."),
            Some(Summary {
                did: "Fixed the flaky test".into(),
                needs: String::new()
            })
        );
        assert_eq!(parse("  \n"), None);
    }
}
