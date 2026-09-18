# Swarm (in progress)

Git isolation is implemented and tested against temporary repositories. Dirty
parents require an explicit `exclude`, `commit-parent`, `commit-child`, or `shared`
choice. Shared/parent-commit modes reject `main` and `master`. Child snapshots use
a private Git index, preserving the parent's staged changes and HEAD. Cleanup
checks repository, branch identity, and cleanliness; retained branches are never
implicitly merged or deleted. Git preparations are serialized by a repository
lock; an interrupted process may require manual inspection and lock removal.

Durable task records, atomic state updates, depth-three limits, direct-relative
messages, inbox acknowledgment, and parent-only result review are implemented and
tested. Failed updates leave the previous state intact. Worker orchestration,
user activation, and the public swarm tools are not wired yet. This directory has no package entry point yet.
