//! The two summary lines an agent ends with, and the system prompt that asks
//! for them.

use crate::model::{Summary, Workspace};
use crate::text::one_line;

const WORKTREE: &str = "\
You work alone in a dedicated git worktree on your own branch. The user is not watching: they \
review your diff later, and pi-desk squash-merges your branch when they approve. You may commit; \
pi-desk commits anything left uncommitted before it merges.";

const MAIN: &str = "\
You work in the user's own checkout on its current branch, not in a separate worktree. Other \
uncommitted changes there may be the user's; do not revert or discard them, and do not switch \
branches. The user is not watching: they review your diff later, and pi-desk commits all changes \
in the checkout onto the branch when they approve. You may commit.";

const FOLDER: &str = "\
You work directly in the user's regular folder, not a Git repository or worktree. Other files \
may be the user's; do not revert, discard, or delete unrelated work. Edits take effect immediately. \
Do not initialize Git, commit, or create branches or worktrees. Pi-desk does not commit, show a \
Git diff, or roll back files in this mode. The user marks the task done after reviewing your \
summary. Use \"Review\" for Needs when no further action is required.";

const REST: &str = "\
Keep working until the task is done; the user may not reply for hours. Do not end your turn \
to report progress or to wait for a job. Start long jobs with bash run_in_background, or with \
nohup or &, then call sleep: it wakes when they finish or exit, or when the user writes.

When you need a decision, call ask_user with short choices and set recommended to the number of \
the choice you recommend. Do not stop to ask in plain text.

End every final message with exactly these two lines:
Did: <what you did, in one sentence>
Needs: <what you need from the user, in one sentence, or \"Review and merge\">";

/// The prompt appended to Pi's system prompt for an agent in `workspace`.
pub fn system_prompt(workspace: &Workspace) -> String {
    let place = match workspace {
        Workspace::Worktree { .. } => WORKTREE,
        Workspace::Main { .. } => MAIN,
        Workspace::Folder { .. } => FOLDER,
    };
    let rest = if workspace.is_folder() {
        REST.replace("Review and merge", "Review")
    } else {
        REST.to_string()
    };
    format!(
        "You are running inside pi-desk, a desktop inbox for parallel Pi agents. {place}\n\n{rest}"
    )
}

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
        did: one_line(&did, 200),
        needs: one_line(needs.unwrap_or(""), 200),
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
