# Swarm

`/swarm:start <objective>` activates fifteen swarm tools. Activation belongs to
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
active and terminal counts, status, branch, workspace, task preview, launch model,
reported current model and thinking level, handoff state, and code evidence.
`finished` in the structured counts means terminal workers, not delivered code.
Pass `nodeId` for the full assignment and result, including a terminal worker.
Pass `includeTerminal: true` to list retained workers too. Pass `model` with an
exact `provider/model` string to filter compact summaries by current model, or
launch model if no session report exists. Counts remain run-wide. Current model
reports update on session load, model/thinking changes, and each agent turn.
Existing workers must reload this extension to report model changes.

`swarm_complete` submits a self-contained handoff: outcome, branch and tested
base, authorized commits (or no commit), changed files, exact checks and results,
evidence, limitations, blockers, and ordered next steps. Workers must distinguish
completed support from gated or unverified behavior. All descendants must be
terminal before submission. Call this tool alone; it ends the turn. Workers
awaiting review cannot call tools or consume inbox messages until a parent
requests changes. Accept/reject stops their process. Acceptance does not merge
the branch. Parents inspect the diff and checks before accepting, then verify
the integrated result.

### Code evidence

Handoff state and code evidence are separate. Compact summaries show `handoff`
as `none`, `awaiting-parent`, `accepted`, `rejected`, or `needs-review`. Accepting
a handoff does not mark any revision reviewed, tested, or integrated.

Use `swarm_record` as the direct parent to record one independent stage:

```text
swarm_record nodeId=<worker> revision=<full commit hash> stage=reviewed evidence="Source diff inspected"
swarm_record nodeId=<worker> revision=<full commit hash> stage=tested evidence="bun test: 10 pass at this revision"
swarm_record nodeId=<worker> revision=<full commit hash> stage=integrated evidence="Cherry-picked as <integration commit>"
```

Use `revision: "result"` for a no-commit handoff. Evidence is parent-reported,
not automatic verification. Each record stores the actor, text, and timestamp.
Recording integration does not imply review or tests. Missing records mean
unrecorded work, not completion. A revised handoff clears `result` evidence but
keeps evidence tied to exact commit hashes. A new record for the same revision
and stage replaces that stage's evidence.

### Graceful replacement

1. Call `swarm_replace` with `action: "request"` and the direct child's `nodeId`.
   This sends one wrap-up instruction. It does not stop a running tool or
   auto-commit WIP. Repeated requests do not send duplicate instructions.
2. Wait for `swarm_complete`. Review the handoff, including the tested base,
   ownership, delivered and pending commits, dirty WIP, and checks. Close all
   descendants, then accept the handoff with `swarm_review`.
3. Call `swarm_replace` with `action: "start"`, the predecessor's `nodeId`, a
   `name`, bounded `task`, explicit target `model`, and `testedBase`. `thinking`
   is optional and defaults to the parent's current level.

Replacement requires a stopped, accepted worker with an isolated Git worktree.
The successor starts at the predecessor HEAD, not the parent's branch. Staged
and unstaged binary patches and nonignored untracked files are copied without a
commit. The successor receives the original assignment, handoff, and provenance
with the resolved tested base, intervening commits, snapshot paths, and file
hashes. The tested base must be an ancestor of the predecessor HEAD. Copied WIP
remains unverified. Ignored files are not copied. Unresolved merges and patch or
copy mismatches block launch.

Only one successor can be reserved. Failures retain available branches,
worktrees, and snapshots for inspection. Do not repeat `action: "start"` after a
failure. Use `swarm_restart` only after a complete snapshot and launch record
exist; incomplete transfers require manual recovery. Predecessor branches and
worktrees remain unchanged. Restart and automatic cleanup of a replacement
predecessor are blocked. Remove it only after manual provenance review.

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
level, handoff state, recorded code-stage counts, unread messages, and task.
The header counts terminal workers, not completed code. Rows show "no pane" when the worker's tmux
session is gone. The panel refreshes every two seconds.

Tool results display plain-text previews. Expand a result to see all fields;
structured result data is unchanged.

Tests cover temporary Git repositories, isolated tmux servers with fake workers,
real Pi worker shutdown, concurrent state writes, routing and authority, review
pauses, prompt injection, model reporting/filtering, independent delivery
records, and replacement of committed and dirty work. Launch tests make no model
requests. End-to-end interactive orchestration and recovery audits remain pending.
