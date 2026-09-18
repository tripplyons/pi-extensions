# Swarm (in progress)

Git isolation is implemented and tested against temporary repositories. Dirty
parents require an explicit `exclude`, `commit-parent`, `commit-child`, or `shared`
choice. Shared/parent-commit modes reject `main` and `master`. Child snapshots use
a private Git index, preserving the parent's staged changes and HEAD. Cleanup
checks repository, branch identity, and cleanliness; retained branches are never
implicitly merged or deleted. Git preparations are serialized by a repository
lock; an interrupted process may require manual inspection and lock removal.

Worker orchestration, user activation, durable messaging, and the public swarm
tools are not wired yet. This directory has no package entry point yet.
