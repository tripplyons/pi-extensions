//! Exercise the real one-shot process interface with a fake model boundary.

#![cfg(unix)]

mod common;

use common::{git, repo};
use pi_desk::commit_message;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn fake_pi(dir: &Path, response: &str) -> String {
    let script = dir.join("pi");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$(dirname \"$0\")/args\"\ncat > \"$(dirname \"$0\")/prompt\"\n{response}\n"
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script.to_str().unwrap().to_string()
}

#[tokio::test]
async fn asks_with_the_final_diff_without_touching_git_or_the_task_session() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let worktree = dir.path().join("worktree");
    pi_desk::git::add_worktree(&repo, &worktree, "task", "main").unwrap();
    std::fs::write(worktree.join("committed.txt"), "committed change\n").unwrap();
    git(&worktree, &["add", "."]);
    git(&worktree, &["commit", "-m", "WIP"]);
    std::fs::write(worktree.join("README.md"), "unstaged change\n").unwrap();
    git(&worktree, &["add", "README.md"]);
    std::fs::write(worktree.join("README.md"), "final unstaged change\n").unwrap();
    std::fs::write(worktree.join("untracked.txt"), "untracked change\n").unwrap();
    let status = git(&worktree, &["status", "--porcelain"]);
    let head = git(&worktree, &["rev-parse", "HEAD"]);
    let base = git(&repo, &["rev-parse", "main"]);
    let program = fake_pi(
        dir.path(),
        "printf 'Describe actual changes\\n\\nExplain why.\\n'",
    );
    let message = commit_message::generate(
        &program,
        &worktree,
        "main",
        "Task request",
        "Completed the task.",
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(message, "Describe actual changes\n\nExplain why.");
    let input = std::fs::read_to_string(dir.path().join("prompt")).unwrap();
    for expected in [
        "Task title:\nTask request",
        "Completed the task.",
        "committed.txt",
        "+committed change",
        "+final unstaged change",
        "untracked.txt",
        "+untracked change",
    ] {
        assert!(input.contains(expected), "missing {expected}: {input}");
    }
    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    for flag in [
        "--print",
        "--no-session",
        "--no-tools",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--system-prompt",
    ] {
        assert!(args.lines().any(|arg| arg == flag), "missing {flag}");
    }
    assert!(args.contains("--name\nCommit message\n"));
    assert!(!args.contains("--session-id"));
    assert_eq!(git(&worktree, &["status", "--porcelain"]), status);
    assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&repo, &["rev-parse", "main"]), base);
}

#[tokio::test]
async fn no_changes_need_no_model_call() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    // A nonexistent executable proves that Pi is never started.
    let result =
        commit_message::generate("/nonexistent/pi-desk-test-pi", &repo, "main", "Task", "")
            .await
            .unwrap();
    assert_eq!(result, None);
}

#[tokio::test]
async fn failed_empty_and_invalid_responses_do_not_change_git() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    std::fs::write(repo.join("untracked.txt"), "keep me\n").unwrap();
    let status = git(&repo, &["status", "--porcelain"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    for (response, error) in [
        ("echo 'model unavailable' >&2; exit 1", "model unavailable"),
        ("printf '  \\n'", "empty commit message"),
        (
            "printf '```text\\nBad format\\n```'",
            "invalid commit message",
        ),
    ] {
        let program = fake_pi(dir.path(), response);
        let result = commit_message::generate(&program, &repo, "main", "Task", "Done").await;
        assert!(result.unwrap_err().contains(error));
        assert_eq!(git(&repo, &["status", "--porcelain"]), status);
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
    }
    assert!(
        commit_message::generate("/nonexistent/pi-desk-test-pi", &repo, "main", "Task", "")
            .await
            .unwrap_err()
            .contains("Could not start Pi")
    );
}
