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

The worker launcher now starts attachable tmux sessions with explicit extension
paths and dedicated Pi session files. Stop, capture, and restart are tested using
a fake executable in an isolated tmux server; no model requests are made.

The controller connects spawning, parent-only subtree stop/restart, result review,
job shutdown, and preflighted cleanup. Integration tests exercise real Git
worktrees with a fake process runtime. Public extension registration is pending.

`/swarm:start <objective>` activates the twelve swarm tools. Activation is persisted
on the root session branch. Workers load the same package entry points, inherit
the model/effort at spawn, and poll durable direct-relative messages. Incoming
messages identify the sender and show its text; result notices point to
`swarm_tree` for review. Root clear preflights all worktrees before stopping
anything. No operation merges or pushes.

Public hooks are now registered and activation/session ownership is tested.
End-to-end interactive worker orchestration and recovery audits remain pending.

Tool results display as plain-text previews instead of JSON. Expand a result to
see all fields and output; structured result data is unchanged.
