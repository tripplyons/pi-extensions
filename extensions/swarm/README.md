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

The worker launcher now starts attachable tmux sessions with dedicated Pi session
files. Workers load all extensions from the user's Pi configuration, with no
allowlist or blocklist. Stop, capture, and restart are tested using
a fake executable in an isolated tmux server; no model requests are made.

The controller connects spawning, parent-only subtree stop/restart, result review,
job shutdown, and preflighted cleanup. Integration tests exercise real Git
worktrees with a fake process runtime. Public extension registration is pending.

`/swarm:start <objective>` activates the twelve swarm tools. Activation is persisted
on the root session branch. Workers load the user's configured extensions, inherit
the model/effort at spawn, and poll durable direct-relative messages. Incoming
messages identify the sender and show its text. All messages use steering, so
parent instructions reach a busy worker at the next tool boundary instead of
waiting for the full turn to end. Steering does not cancel a tool already running;
use `swarm_stop` or `/swarm:kill` for a hard stop. Result notices point to
`swarm_tree` for review. `swarm_complete` is a direct model tool that ends the
turn when called alone. Workers awaiting review cannot call tools or consume inbox
messages until a parent requests changes. Accept/reject stops their process.
Root clear preflights all worktrees before stopping anything. No operation merges
or pushes.

Public hooks are now registered and activation/session ownership is tested.
End-to-end interactive worker orchestration and recovery audits remain pending.

Tool results display as plain-text previews instead of JSON. Expand a result to
see all fields and output; structured result data is unchanged.

The root session owner can run `/swarm:kill` to stop all workers and their jobs.
Records, worktrees, sessions and branches are kept, so parents can restart
stopped workers. `/swarm:status` shows or hides a panel below the editor. The
panel lists active workers under the current node as a tree. Each row shows
status, time since the last start, model and thinking level, unread messages and
the task. Rows show "no pane" when the worker's tmux session is gone. The panel
refreshes every two seconds.
