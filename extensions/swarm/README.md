# Swarm

`/swarm:start <objective>` activates thirteen swarm tools. Activation belongs to
the root session branch. Workers run in attachable tmux sessions with dedicated
Pi session files. They load the user's configured extensions and inherit the
model and thinking level at spawn. Tasks and messages live under
`~/.pi/agent/swarm` (`PI_CODING_AGENT_DIR` overrides this).

## Assignments and handoffs

Workers do not inherit the parent's conversation. Each assignment should describe
one bounded step, owned files, dependencies, acceptance checks, resource limits,
and permission to commit. Coordination guidelines are added to the system prompt
on every turn, including after recovery. Workers ask their parent, not the user.
They coordinate shared APIs before editing and report blockers rather than
inventing substitute behavior or starting follow-on work.

`swarm_task` returns the objective, full node record, parent ID and workspace,
and nonterminal sibling IDs. `swarm_tree` returns compact summaries by default:
active and finished counts, status, branch, workspace, a task preview, and whether
a result exists. Pass `nodeId` for the full assignment and result, including a
terminal worker. Pass `includeTerminal: true` to list retained workers too.

`swarm_complete` submits a self-contained handoff: outcome, branch and tested
base, authorized commits (or no commit), changed files, exact checks and results,
evidence, limitations, blockers, and ordered next steps. Workers must distinguish
completed support from gated or unverified behavior. All descendants must be
terminal before submission. Call this tool alone; it ends the turn. Workers
awaiting review cannot call tools or consume inbox messages until a parent
requests changes. Accept/reject stops their process. Acceptance does not merge
the branch. Parents inspect the diff and checks before accepting, then verify
the integrated result.

## Messages and shared instructions

`swarm_send` accepts informational messages to a parent, direct child, or sibling.
Only parents may send instructions to their direct children. More distant nodes
require a relay. Incoming messages identify the sender and show the text.

`swarm_broadcast` sends one message or instruction to all nonterminal direct
children in one atomic update. It includes workers awaiting review, but they read
the message only if resumed. It excludes terminal children and grandchildren.
Use it for shared base-update notices, resource limits, or instructions to finish
only the assigned step and submit.

All messages use steering, so a busy worker reads them at the next tool boundary.
Steering does not cancel a running tool. Use `swarm_stop` or `/swarm:kill` for a
hard stop. Durable state updates retry lock contention for up to five seconds;
other filesystem errors propagate. A stale lock is not deleted automatically.
An interrupted process may require manual inspection and lock removal.

## Git isolation

Dirty parents require an explicit `exclude`, `commit-parent`, `commit-child`, or
`shared` choice. Shared/parent-commit modes reject `main` and `master`. Child
snapshots use a private Git index, preserving the parent's staged changes and
HEAD. Git preparations are serialized by a repository lock.

Swarm tools never merge or push. Only the parent integrates worker branches into
its branch. Workers may sync an explicitly approved base into their own branch.
They pin the tested base and do not repeat full checks just because an unrelated
base update arrives after testing. Cleanup checks repository, branch identity,
and cleanliness. Retained branches are never implicitly merged or deleted.
Root clear preflights all worktrees before stopping anything.

## Controls and tests

The root session owner can run `/swarm:kill` to stop all workers and their jobs.
Records, worktrees, sessions, and branches are kept so parents can restart stopped
workers. `/swarm:status` shows or hides a panel below the editor. It lists active
workers under the current node, including status, elapsed time, model, thinking
level, unread messages, and task. Rows show "no pane" when the worker's tmux
session is gone. The panel refreshes every two seconds.

Tool results display plain-text previews. Expand a result to see all fields;
structured result data is unchanged.

Tests cover temporary Git repositories, isolated tmux servers with fake workers,
real Pi worker shutdown, concurrent state writes, routing and authority, review
pauses, prompt injection, and compact tree lookup. Launch tests make no model
requests. End-to-end interactive orchestration and recovery audits remain pending.
