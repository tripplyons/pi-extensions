//! Git through the git CLI: worktrees, diffs, and squash merges.
//!
//! The squash merge is computed with `git merge-tree --write-tree` and
//! `git commit-tree`, so it never checks anything out. If the base branch is
//! checked out somewhere, that checkout fast-forwards; otherwise the branch
//! ref moves with a compare-and-swap.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn run(dir: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("git: {error}"))
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = run(dir, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "git {}: {}",
            args.first().unwrap_or(&""),
            stderr.trim()
        ))
    }
}

pub fn toplevel(path: &Path) -> Result<PathBuf, String> {
    git(path, &["rev-parse", "--show-toplevel"]).map(PathBuf::from)
}

pub fn current_branch(repo: &Path) -> Result<String, String> {
    git(repo, &["symbolic-ref", "--short", "HEAD"]).map_err(|_| {
        format!(
            "{} is not on a branch; check out the branch tasks should merge into",
            repo.display()
        )
    })
}

pub fn add_worktree(repo: &Path, path: &Path, branch: &str, base: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let path = path.to_string_lossy();
    git(
        repo,
        &["worktree", "add", "--quiet", "-b", branch, &path, base],
    )
    .map(|_| ())
}

/// Removes the worktree and, unless `keep_branch`, its branch. Missing
/// pieces are not errors, so cleanup can be retried.
pub fn remove(repo: &Path, worktree: &Path, branch: &str, keep_branch: bool) -> Result<(), String> {
    if worktree.exists() {
        git(
            repo,
            &["worktree", "remove", "--force", &worktree.to_string_lossy()],
        )?;
    }
    let _ = git(repo, &["worktree", "prune"]);
    if !keep_branch
        && git(
            repo,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok()
    {
        git(repo, &["branch", "-D", branch])?;
    }
    Ok(())
}

/// Commits every change in the worktree. Returns false when it was clean.
pub fn commit_all(worktree: &Path, message: &str) -> Result<bool, String> {
    if git(worktree, &["status", "--porcelain"])?.is_empty() {
        return Ok(false);
    }
    git(worktree, &["add", "-A"])?;
    git(worktree, &["commit", "--quiet", "-m", message])?;
    Ok(true)
}

/// The branch's changes against where it left `base`, including uncommitted
/// and untracked files.
pub fn diff(worktree: &Path, base: &str) -> Result<String, String> {
    let merge_base = git(worktree, &["merge-base", base, "HEAD"])?;
    let mut text = git(
        worktree,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--find-renames",
            &merge_base,
        ],
    )?;
    let untracked = git(
        worktree,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    for file in untracked.split('\0').filter(|file| !file.is_empty()) {
        // --no-index exits 1 when the files differ, which is the point here.
        let output = run(
            worktree,
            &["diff", "--no-color", "--no-index", "--", "/dev/null", file],
        )?;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&output.stdout));
    }
    Ok(text)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Added,
    Removed,
    Context,
    Hunk,
    Meta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileDiff {
    pub path: String,
    pub added: usize,
    pub removed: usize,
    pub lines: Vec<DiffLine>,
}

pub fn parse_diff(text: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let path = rest
                .rsplit_once(" b/")
                .map(|(_, path)| path)
                .unwrap_or(rest);
            files.push(FileDiff {
                path: path.to_string(),
                ..FileDiff::default()
            });
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        let has_hunk = file.lines.iter().any(|line| line.kind == LineKind::Hunk);
        if !has_hunk {
            if let Some(path) = line.strip_prefix("+++ b/") {
                file.path = path.to_string();
            } else if line.starts_with("Binary files") {
                file.lines.push(DiffLine {
                    kind: LineKind::Meta,
                    text: "Binary file changed".into(),
                });
            } else if let Some(rest) = line.strip_prefix("rename from ") {
                file.lines.push(DiffLine {
                    kind: LineKind::Meta,
                    text: format!("Renamed from {rest}"),
                });
            }
            if !line.starts_with("@@") {
                continue;
            }
        }
        let (kind, text) = if line.starts_with("@@") {
            (LineKind::Hunk, line)
        } else if let Some(text) = line.strip_prefix('+') {
            file.added += 1;
            (LineKind::Added, text)
        } else if let Some(text) = line.strip_prefix('-') {
            file.removed += 1;
            (LineKind::Removed, text)
        } else if let Some(text) = line.strip_prefix(' ') {
            (LineKind::Context, text)
        } else {
            (LineKind::Meta, line)
        };
        file.lines.push(DiffLine {
            kind,
            text: text.to_string(),
        });
    }
    files
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Merge {
    Merged { commit: String },
    NoChanges,
    Conflict { files: Vec<String> },
}

fn checkout_of(repo: &Path, branch: &str) -> Result<Option<PathBuf>, String> {
    let list = git(repo, &["worktree", "list", "--porcelain"])?;
    let wanted = format!("branch refs/heads/{branch}");
    let mut current = None;
    for line in list.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current = Some(PathBuf::from(path));
        } else if line == wanted {
            return Ok(current);
        }
    }
    Ok(None)
}

/// Commits what is left in the worktree, then squash-merges `branch` into
/// `base` as one commit with `message`. Does not remove the worktree.
pub fn squash_merge(
    repo: &Path,
    worktree: &Path,
    branch: &str,
    base: &str,
    message: &str,
) -> Result<Merge, String> {
    commit_all(worktree, message)?;
    let base_ref = format!("refs/heads/{base}");
    let base_tip = git(repo, &["rev-parse", "--verify", &base_ref])?;
    let output = run(
        repo,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            &base_ref,
            branch,
        ],
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut lines = stdout.lines();
    let tree = lines.next().unwrap_or_default().trim().to_string();
    match output.status.code() {
        Some(0) => {}
        Some(1) => {
            let files: Vec<String> = lines
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect();
            return Ok(Merge::Conflict { files });
        }
        _ => {
            return Err(format!(
                "git merge-tree: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    if tree == git(repo, &["rev-parse", &format!("{base_tip}^{{tree}}")])? {
        return Ok(Merge::NoChanges);
    }
    let commit = git(
        repo,
        &["commit-tree", &tree, "-p", &base_tip, "-m", message],
    )?;
    match checkout_of(repo, base)? {
        Some(checkout) => {
            git(&checkout, &["merge", "--quiet", "--ff-only", &commit]).map_err(|error| {
                format!(
                    "Could not update your {base} checkout at {}: {error}",
                    checkout.display()
                )
            })?
        }
        None => git(repo, &["update-ref", &base_ref, &commit, &base_tip])?,
    };
    Ok(Merge::Merged { commit })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_files_counts_and_hunks() {
        let text = "diff --git a/src/a.rs b/src/a.rs\nindex 1..2 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,2 @@\n fn a() {\n-  old\n+  new\n+  more\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\n\\ No newline at end of file\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
        let files = parse_diff(text);
        assert_eq!(
            files
                .iter()
                .map(|file| (file.path.as_str(), file.added, file.removed))
                .collect::<Vec<_>>(),
            [("src/a.rs", 2, 1), ("new.txt", 1, 0), ("img.png", 0, 0)]
        );
        assert_eq!(files[0].lines[0].kind, LineKind::Hunk);
        assert_eq!(
            files[0].lines[2],
            DiffLine {
                kind: LineKind::Removed,
                text: "  old".into()
            }
        );
        assert_eq!(files[1].lines.last().unwrap().kind, LineKind::Meta);
        assert_eq!(files[2].lines[0].text, "Binary file changed");
    }
}
