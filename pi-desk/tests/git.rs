mod common;

use common::{git, repo};
use pi_desk::git::{self as desk_git, Merge};

#[test]
fn squash_merge_fast_forwards_a_clean_checkout_of_the_base_branch() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let worktree = dir.path().join("worktrees/task");
    desk_git::add_worktree(&repo, &worktree, "pi-desk/task", "main").unwrap();

    std::fs::write(worktree.join("README.md"), "hello\nworld\n").unwrap();
    git(&worktree, &["commit", "--quiet", "-am", "Agent commit"]);
    std::fs::write(worktree.join("new.txt"), "untracked\n").unwrap();

    let diff = desk_git::parse_diff(&desk_git::diff(&worktree, "main").unwrap());
    let summary: Vec<(&str, usize, usize)> = diff
        .iter()
        .map(|file| (file.path.as_str(), file.added, file.removed))
        .collect();
    assert_eq!(summary, [("README.md", 1, 0), ("new.txt", 1, 0)]);

    let result = desk_git::squash_merge(
        &repo,
        &worktree,
        "pi-desk/task",
        "main",
        "Add world\n\nWrote it.",
    )
    .unwrap();
    assert!(matches!(result, Merge::Merged { .. }));
    // One squashed commit on main, and the main checkout's files updated.
    assert_eq!(git(&repo, &["rev-list", "--count", "main"]), "2");
    assert_eq!(
        git(&repo, &["log", "-1", "--format=%s", "main"]),
        "Add world"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("new.txt")).unwrap(),
        "untracked\n"
    );
    assert_eq!(git(&repo, &["status", "--porcelain"]), "");

    desk_git::remove(&repo, &worktree, "pi-desk/task", false).unwrap();
    assert!(!worktree.exists());
    assert!(git(&repo, &["branch", "--list", "pi-desk/task"]).is_empty());
}

#[test]
fn squash_merge_moves_a_base_branch_that_is_not_checked_out() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    git(&repo, &["branch", "release"]);
    let worktree = dir.path().join("worktrees/task");
    desk_git::add_worktree(&repo, &worktree, "pi-desk/task", "release").unwrap();
    std::fs::write(worktree.join("fix.txt"), "fix\n").unwrap();

    let result =
        desk_git::squash_merge(&repo, &worktree, "pi-desk/task", "release", "Fix").unwrap();
    assert!(matches!(result, Merge::Merged { .. }));
    assert_eq!(git(&repo, &["show", "release:fix.txt"]), "fix");
    assert_eq!(git(&repo, &["rev-list", "--count", "main"]), "1");
}

#[test]
fn conflicts_are_reported_and_nothing_moves() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let worktree = dir.path().join("worktrees/task");
    desk_git::add_worktree(&repo, &worktree, "pi-desk/task", "main").unwrap();
    std::fs::write(worktree.join("README.md"), "agent\n").unwrap();
    std::fs::write(repo.join("README.md"), "user\n").unwrap();
    git(&repo, &["commit", "--quiet", "-am", "User change"]);
    let before = git(&repo, &["rev-parse", "main"]);

    let result =
        desk_git::squash_merge(&repo, &worktree, "pi-desk/task", "main", "Agent change").unwrap();
    assert_eq!(
        result,
        Merge::Conflict {
            files: vec!["README.md".into()]
        }
    );
    assert_eq!(git(&repo, &["rev-parse", "main"]), before);
}

#[test]
fn a_branch_without_changes_is_not_merged() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let worktree = dir.path().join("worktrees/task");
    desk_git::add_worktree(&repo, &worktree, "pi-desk/task", "main").unwrap();
    assert_eq!(
        desk_git::squash_merge(&repo, &worktree, "pi-desk/task", "main", "Nothing").unwrap(),
        Merge::NoChanges
    );
}

#[test]
fn detached_checkouts_are_rejected_as_a_base() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    assert_eq!(desk_git::current_branch(&repo).unwrap(), "main");
    let head = git(&repo, &["rev-parse", "HEAD"]);
    git(&repo, &["checkout", "--quiet", "--detach", &head]);
    assert!(
        desk_git::current_branch(&repo)
            .unwrap_err()
            .contains("not on a branch")
    );
}

#[test]
fn main_checkout_diffs_from_its_start_and_commits_only_on_its_branch() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let start = desk_git::head(&repo).unwrap();
    std::fs::write(repo.join("committed.txt"), "agent commit\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "--quiet", "-m", "Agent commit"]);
    std::fs::write(repo.join("new.txt"), "untracked\n").unwrap();

    let paths: Vec<String> = desk_git::parse_diff(&desk_git::diff(&repo, &start).unwrap())
        .into_iter()
        .map(|file| file.path)
        .collect();
    assert_eq!(paths, ["committed.txt", "new.txt"]);

    git(&repo, &["checkout", "--quiet", "-b", "elsewhere"]);
    let error = desk_git::commit_checkout(&repo, "main", "Task").unwrap_err();
    assert!(error.contains("not main"));
    assert!(!git(&repo, &["status", "--porcelain"]).is_empty());

    git(&repo, &["checkout", "--quiet", "main"]);
    let Merge::Merged { commit } = desk_git::commit_checkout(&repo, "main", "Task").unwrap() else {
        panic!("expected a commit")
    };
    assert_eq!(commit, desk_git::head(&repo).unwrap());
    assert!(git(&repo, &["status", "--porcelain"]).is_empty());
    assert_eq!(git(&repo, &["log", "-1", "--format=%s"]), "Task");
}

#[test]
fn add_worktree_reuses_a_kept_branch_and_recreates_a_deleted_one() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo(dir.path());
    let worktree = dir.path().join("worktrees/task");
    desk_git::add_worktree(&repo, &worktree, "pi-desk/task", "main").unwrap();
    std::fs::write(worktree.join("kept.txt"), "kept\n").unwrap();
    git(&worktree, &["add", "kept.txt"]);
    git(&worktree, &["commit", "--quiet", "-m", "Keep"]);

    // Mark done keeps the branch; reopening checks it out again.
    desk_git::remove(&repo, &worktree, "pi-desk/task", true).unwrap();
    desk_git::add_worktree(&repo, &worktree, "pi-desk/task", "main").unwrap();
    assert!(worktree.join("kept.txt").exists());

    // Discard deletes the branch; reopening starts fresh from the base.
    desk_git::remove(&repo, &worktree, "pi-desk/task", false).unwrap();
    desk_git::add_worktree(&repo, &worktree, "pi-desk/task", "main").unwrap();
    assert!(!worktree.join("kept.txt").exists());
    assert_eq!(
        git(&worktree, &["rev-parse", "HEAD"]),
        git(&repo, &["rev-parse", "main"])
    );
}
