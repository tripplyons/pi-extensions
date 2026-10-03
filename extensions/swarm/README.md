# Swarm

`/swarm:start <objective>` activates eighteen swarm tools. Activation belongs to
the root session branch. Workers run in attachable tmux sessions with dedicated
Pi session files. They load the user's configured extensions and inherit the
model, thinking level, and fast-mode preference at spawn. A replacement inherits
the spawning parent's current fast-mode preference. This requests priority service
only for OpenAI models and can affect billing. Parent toggles do not change live
workers. Restarts copy the restarting parent's current model, thinking level, and fast-mode
preference. Tasks and messages live under
`~/.pi/agent/swarm` (`PI_CODING_AGENT_DIR` overrides this).

## Assignments and handoffs

Workers do not inherit the parent's conversation. Each assignment should describe
one bounded step, owned files, dependencies, acceptance checks, resource limits,
and permission to commit. Permission to proceed is separate from recent activity:
`released`, `waiting-approval`, `waiting-dependency`, or `checkpoint-hold`.
A check-in, instruction delivery, or tool event does not release a wait. Use
`swarm_send` or `swarm_broadcast` with `kind: "instruction"` and
`permission: "released"` to authorize a bounded step after a wait. Waiting workers
can read files with `read`, `grep`, `find`, and `ls`, coordinate with the parent,
inspect swarm state, and inspect or stop tasks. They can also manage context with
`compress`, `search_context`, `acp_status`, `acp_cache`, and `decompress` without
`toFile`. These calls do not release permission. The same rule applies to reload
checkpoint holds. Bash, codemode, file-writing tools (including `decompress` with
`toFile`), new jobs, and unknown tools stay blocked. Review and terminal workers
remain paused for all tools. Old records without permission state show `unknown`;
activity does not reconstruct it.
Coordination guidelines are added to the system prompt
on every turn, including after recovery. Workers ask their parent, not the user.
They coordinate shared APIs before editing and report blockers rather than
inventing substitute behavior or starting follow-on work.

`swarm_task` returns the objective, full node record, parent ID and workspace,
and nonterminal sibling IDs. Its `currentAssignment` has a numeric generation,
separate from the process launch generation. Each new directive increments it.
`observedAssignment` records the generation and launch last read through
`swarm_task`. It proves the durable assignment was read, not that work started or
finished. A stale launch or a concurrent assignment change cannot acknowledge
the new scope. Compact trees include both generations and the observation. `swarm_tree` returns compact summaries by default:
active and terminal counts, status, branch, workspace, task preview, launch model,
reported current model and thinking level, handoff state and revision, and code evidence.
`finished` in the structured counts means terminal workers, not delivered code.
Pass `nodeId` for the full assignment and result, including a terminal worker.
Pass `includeTerminal: true` to list retained workers too. Pass `model` with an
exact `provider/model` string to filter compact summaries by current model, or
launch model if no session report exists. Counts remain run-wide. Current model
reports update on session load, model/thinking changes, and each agent turn.
Existing workers must reload this extension to report model changes.

Each session reports a package-source fingerprint captured when the extension
loads. The tree exposes `runtime.revision`, `runtime.loaded`, and whether the
revision matches the root's reported source. The panel shows a short fingerprint,
a mismatch, or `version unknown`. This is a source fingerprint, not a Git commit
or a claim that tests passed. Old workers remain unknown until they load the new
extension. Editing files does not update a loaded session's fingerprint.

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
as `none`, `awaiting-parent`, `accepted`, `rejected`, `changes-requested`, or
`unknown`. The full node stores the latest handoff revision, decision, and review
feedback independently of its process status. Restarting or stopping a worker
preserves that decision. Each new submission increments the handoff revision and
sets it to `awaiting-parent`. Accepting a handoff does not mark any code revision
reviewed, tested, or integrated.

Old records with an accepted, rejected, or awaiting-review lifecycle status are
migrated on load. Old running or stopped records with a retained result but no
saved decision show `unknown`, not a review backlog. The lost decision cannot be
recovered from lifecycle status alone.

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

Handoff submission and its parent notification are saved atomically.
`swarm_review` with `request-changes` saves the running state and resume instruction
atomically. Its returned node includes `resume.status: "queued"`; this is not an
acknowledgment from the worker. Inspect `swarm_tree` to see `delivered` after Pi
accepts the steering instruction, then `observed` after the worker reaches a tool
boundary in the resumed state. The parent receives a separate observed notice.
Neither state proves the model understood the instruction or completed the work.
A pause error names the handoff revision and describes a snapshot at the tool
check. A delayed snapshot can be superseded by a later parent resume.

A new parent directive, request-changes, restart task, or reload release
supersedes older queued instructions. Superseded instructions stay in the saved
message history but are not replayed to the worker. An explicit restart task
also clears the old resume signal. Historical handoffs remain separate from the
current assignment and retain their review decisions.

Current messages use steering, so a busy worker reads them at the next tool boundary.
Steering does not cancel a running tool. Use `swarm_stop` or `/swarm:kill` for a
hard stop. Durable state updates retry lock contention for up to five seconds;
other filesystem errors propagate. A stale lock is not deleted automatically.
An interrupted process may require manual inspection and lock removal.

## Reload barrier

Use a reload barrier to update running direct children without letting restart
instructions authorize new work:

1. Call `swarm_reload action=request`, optionally with `nodeIds`. Members must
   be running direct children with terminal descendants and no pending replacement.
2. Each worker finishes only its existing bounded step, finishes or stops owned
   jobs, then calls `swarm_reload action=checkpoint` alone with `barrierId` and a
   self-contained `checkpoint`. Include dirty files, pinned bases, checks, and
   recovery details. This ends the worker turn and holds editing and new jobs.
3. After every member checkpoints, call `swarm_reload action=restart` with the
   barrier ID. It stops and restarts members without assigning new work. It
   checks both managed Bash tasks and tmux jobs. Unknown job ownership blocks
   checkpoint or restart instead of assuming no jobs.
4. Reload the parent too if its source is old. Read `action=status` until every
   member reports readiness from its new launch generation. Ready workers remain
   on checkpoint hold. Matching source fingerprints are required for release.
5. Call `action=release` with one `{nodeId, task}` bounded assignment for every
   member. Release saves the new assignments, permissions, and steering messages
   atomically. Ordinary instructions cannot lift checkpoint holds.

Barrier state, checkpoints, and readiness survive recovery. Failed restarts retain
checkpoints and an error. Inspect the failure before retrying `action=restart`;
workers with live restarted sessions are not launched twice. The barrier does not
commit, merge, or discard work. Workers running old code cannot call the checkpoint
tool. Manually checkpoint and reload those sessions first; the barrier is not a
way to add tools to an already loaded old runtime.

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
workers. `swarm_restart` keeps the worker's session and worktree. It copies the
parent's current model, thinking level, and fast-mode preference by default. Supply
`thinking: "low"` (or `off`, `minimal`, `medium`, `high`, `xhigh`) to override it.
Restart refuses a live worker; stop it first. It does not restart old jobs.

`/swarm:status` shows or hides a panel below the editor. It lists active
workers under the current node, including status, elapsed time, model, thinking
level, handoff state, recorded code-stage counts, unread messages, and task.
Running or starting workers label retained results as "previous handoff". A new
submission in review shows the current handoff. Both labels retain separate code
evidence; restarting a worker does not clear its handoff decision.
`swarm_restart` accepts an optional `task` for the next bounded assignment.
It saves that assignment before launch. `swarm_task.currentAssignment` exposes the
latest parent instruction or restart assignment, separate from `historicalHandoff`.
The original `node.task` remains available as context. Completed handoffs and their
feedback do not authorize a new task. If no current assignment exists, the worker
must ask the parent and wait. Instructions sent with `swarm_send` or
`swarm_broadcast` remain available after delivery and recovery; sending them does
not resume a review worker.

Workers report activity through `swarm_send` to their parent:
`activity: "working"`, `"waiting-instructions"`, or `"waiting-dependency"`.
The message text gives the reason. The tree exposes the report and timestamp.
The panel shows the latest activity signal and its age instead of calling every
running process working. An ordinary worker-to-parent message records `checking-in`
when it has no explicit activity report. Non-swarm tool checks record `tool-active`.
Parent instructions replace old waiting labels with `instruction-queued`, then
`instruction-delivered` when Pi accepts the instruction. Acknowledging an older
instruction cannot replace the state of a newer one. Recovery also corrects legacy
waiting reports when a newer matching parent instruction is present.
The tree identifies each signal's source. The panel distinguishes observed events
from explicit worker reports. Tool checks and check-ins do not prove useful progress,
completed tool execution, or instruction understanding. Reading swarm state alone
does not mark a worker tool-active. Workers should still explicitly report waits.
Activity with no report or observed event is `unknown`. Restart and completion clear
activity; a request for changes records a new queued instruction.
The parent prompt lists the three oldest pending direct-child reviews on each
new turn, plus the remaining count. `swarm_reviews` lists the full queue with
submission times, wait ages, review owners, overdue state, and parent-reported
integrated revisions. Pass `nodeId` to inspect a full handoff. `/swarm:reviews`
offers inspect, accept, request-changes, and reject with feedback. Inspection
does not record a decision. The parent must still read the diff and evidence.

Handoffs become overdue after 300 seconds. While a direct-child backlog remains
overdue, the extension sends the parent one aggregate steering reminder every
five minutes. It lists up to three handoffs, oldest first, and asks for explicit
`swarm_review` decisions before follow-on assignments. A busy parent receives it
at a tool boundary; an idle parent gets a new turn. Reminders wait while the
session already has pending messages so they do not pile up. Reminders do not cancel tools,
accept handoffs, change permissions, stop workers, or integrate branches. Each
parent handles its own direct children; ancestor sessions do not send reminders
for a descendant's queue. Resolved, resumed, and stopped workers leave the queue.
Reloading the extension starts a new reminder cycle.

Legacy handoffs with no known submission time show an unknown age, not overdue.
They receive reminders after five minutes of local observation without an
invented submission time. The observation timer resets on reload. Recorded
integration with an undecided handoff is flagged in the review queue, status,
panel, and parent prompts. This is parent-reported evidence for listed revisions,
possibly from an earlier handoff, not proof that the whole current result is
integrated. It never implies acceptance, source review, or successful tests.

The active count includes workers paused for review. The header gives a separate
`awaiting-parent` count, and review rows show `await-parent` in warning color.
Parents also receive a warning for each new handoff revision and a pending-review
status indicator with direct-child overdue and recorded-integration counts. The header counts terminal workers, not completed code. Rows show "no pane" when the worker's tmux
session is gone. The panel refreshes every two seconds. It also shows permission state, source
version, review age and owner, and quiet-activity diagnostics.

`swarm_health` reports process presence, recent activity age, and owned managed
Bash tasks and tmux jobs. It distinguishes `quiet-with-job`, `quiet-no-job`,
`recent`, `awaiting-review`, and `unknown`. Unknown job ownership includes the
read error. Quiet does not mean stalled, and a live job does not prove progress.
The extension checks every ten seconds and warns once per warning episode for
missing worker panes or quiet workers without a known permission wait. Use
`/swarm:quiet <seconds>` to change the branch's quiet threshold, default 300.
Inspect with `swarm_health` or `swarm_observe`. Diagnostics never stop or restart
workers automatically.

Tool results display plain-text previews. Expand a result to see all fields;
structured result data is unchanged.

Tests cover temporary Git repositories, isolated tmux servers with fake workers,
real Pi worker shutdown, concurrent state writes, routing and authority, review
pauses, prompt injection, model reporting/filtering, independent delivery
records, replacement of committed and dirty work, reload barrier recovery,
explicit permissions, age-ordered reviews, bounded recurring review reminders,
integrated-but-undecided indicators, and read-only job diagnostics. Launch tests make no model
requests. End-to-end interactive orchestration and recovery audits remain pending.
