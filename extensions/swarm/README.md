# Swarm

`/swarm:start <objective>` activates twenty swarm tools. Activation belongs to
the root session branch. Workers run in attachable tmux sessions with dedicated
Pi session files. They load the user's configured extensions and inherit the
model, thinking level, and fast-mode preference at spawn. A replacement inherits
the spawning parent's current fast-mode preference. This requests priority service
only for OpenAI models and can affect billing. Parent toggles do not change live
workers. Restarts reuse the worker's own settings: its reported current model and
thinking level, then its launch settings, then the restarting parent's current
settings for any value still missing. `swarm_spawn` and `swarm_restart` accept `model` (exact
`provider/model`), `thinking` (reasoning effort), and `fast` (boolean) to override the inherited values. Replacement starts accept the same fields, with `model` required. `swarm_models`
lists the accepted models: Pi's scoped models (`/scoped-models`, `enabledModels`,
or `--models`), or all authenticated models when no scope is set. Omitted fields stay inherited.
For example, spawn or restart with `model: "openai/gpt-5.4"`,
`thinking: "max"`, and `fast: true` (use an available model ID).
Reasoning effort accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. The selected model determines which efforts Pi can use.
To resume a paused review worker with different settings, pass these fields to
`swarm_review` with `decision: "request-changes"`. The worker process is stopped
and relaunched in its saved session. Omitted fields retain the worker's reported
model/thinking and saved fast preference. Without overrides, review resumes the
existing process as before. Accept/reject decisions do not accept overrides. Tasks and messages live under
`~/.pi/agent/swarm` (`PI_CODING_AGENT_DIR` overrides this).

## Assignments and handoffs

Workers do not inherit the parent's conversation. Each assignment should describe
one bounded step, owned files, dependencies, acceptance checks, resource limits,
and permission to commit. Permission to proceed is separate from recent activity:
`released`, `waiting-approval`, `waiting-dependency`, or `checkpoint-hold`.
A check-in, instruction delivery, or tool event does not release a wait. Use
`swarm_send` or `swarm_broadcast` with `kind: "instruction"` and
`permission: "released"` to authorize a bounded step after a wait. Waiting workers
can read files with `read`, `grep`, `find`, and `ls`, coordinate with other agents,
inspect swarm state, and inspect, watch, or stop tasks. They can run one read-only
Bash command, such as `date`, `git status`, `git log`, or `git diff`, with a
15-second limit and no redirection, chaining, or background mode. Pipes between
read-only commands are allowed. They can also use `todo_write` and `complain`, and
manage context with `compress`, `search_context`, `acp_status`, `acp_cache`, and
`decompress` without `toFile`. These calls do not release permission. The same rule applies to reload
checkpoint holds. Codemode can dispatch these allowed tools; Pi checks each
nested call against the current worker state, including permission changes during
a script. During a permission wait, but not a reload checkpoint hold, a worker can also
submit a finished handoff with `swarm_complete`. Other Bash commands, file-writing tools
(including `decompress` with `toFile`), new jobs, and unknown tools stay blocked. Do not use codemode model calls during a hold. Review and terminal workers
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
the new scope. Compact trees include both generations and the observation. Pass `brief: true` to
`swarm_tree` for one short record per worker: ID, parent, name, status, activity,
permission, reload stage, version state, and handoff. `swarm_tree` returns compact summaries by default:
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
revision matches the root's reported source. The panel shows a short fingerprint
only for a mismatch, or `version unknown` when either source is missing. This is a
source fingerprint, not a Git commit or a claim that tests passed. Old workers remain unknown until they load the new
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

`swarm_send` sends informational messages directly to any other agent in the same
swarm run. This includes siblings, workers under different parents, and more
distant ancestors or descendants. No parent relay is needed. Use `swarm_tree` to
find recipient node IDs and parent relationships, then set `to` to the node ID.
Names are display labels, not routing addresses. Self-messages and recipients
from another run are rejected.

Ask the responsible agent about APIs and dependencies directly. Send scope,
ownership, permission decisions, and unresolved blockers to your parent.
Only direct parents may send instructions, change assignments, or release
permission waits. Messages from other agents are informational; they do not
authorize edits, new jobs, or follow-on work.

```json
{"to":"<agent-node-id>","kind":"message","text":"Does getRecord(id: string): Record cover what client.ts needs?"}
```

Messages are stored in run state and delivered through the recipient's inbox.
Incoming messages identify the sender by name and node ID. Messages from agents
other than the worker's direct parent include an informational-only notice.
A busy recipient receives the message at a tool boundary; an idle recipient
gets a new turn. Review and terminal workers do not consume inbox messages.
Their queued messages become eligible for delivery only if their parent resumes
or restarts them. A message does not stop a running tool or resume a paused worker.
Existing workers must reload this extension to send messages beyond their parent,
direct children, and siblings.

Instructions now **append by default**. Both tools accept `assignmentMode` for
`kind: "instruction"`:

- `"append"` (default) preserves the current task and adds the instruction. Use
  it for a rebase order, a new constraint, or a correction that keeps the task.
  Later additions take precedence where they conflict. Other scope, ownership,
  checks, and commit permission remain in the assignment.
- `"replace"` discards the current assignment and saves the supplied text as the
  whole new task. Include the full bounded scope, ownership, dependencies, checks,
  resource limits, and commit permission. Use it to change tasks or consolidate
  accumulated updates. The original `node.task` remains historical context.

Use `kind: "message"` for informational notices that must not change the
assignment, such as "Main advanced; no rebase needed." Messages cannot set
`assignmentMode` or change permission. An instruction without `permission` also
leaves permission unchanged. Appending does not restart completed work or
permit follow-on work. Workers read `swarm_task` after an instruction because a
steering message can be superseded before they act.

Appends require a current assignment. They cannot revive a completed task.
A broadcast append fails without saving any changes if any recipient has no
current assignment, including a worker awaiting review. Use a message for a
notice to all workers, or send an instruction to each active worker. Use
`swarm_review` for a completed handoff, not an appended follow-on task.
An explicit replacement still does not resume a review worker.

`swarm_broadcast` sends one message or instruction to all nonterminal direct
children in one atomic update. It includes workers awaiting review, but they read
the message only if resumed. It excludes terminal children and grandchildren.
Use `kind: "message"` for shared base-update notices. Use an appended instruction
for shared resource limits or an order to finish only the assigned step and submit.
Each recipient keeps its own task when appending.

```json
{"kind":"message","text":"Main advanced to b4238eb. No action required."}
{"kind":"instruction","assignmentMode":"append","text":"Rebase onto b4238eb before your next code commit, then continue the remaining assigned work."}
```

Before this change, every instruction replaced the task. Existing callers that
intend replacement must now send `assignmentMode: "replace"`.

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
supersedes older queued instructions. An appended instruction saves and delivers
the full combined assignment, so superseding an unread message does not lose
its update. Superseded instructions stay in the saved message history but are
not replayed to the worker. An explicit restart task
also clears the old resume signal. Historical handoffs remain separate from the
current assignment and retain their review decisions.

Current messages use steering, so a busy worker reads them at the next tool boundary.
Steering does not cancel a running tool. Use `swarm_stop` or `/swarm:kill` for a
hard stop. Durable state updates retry lock contention for up to five seconds;
other filesystem errors propagate. A stale lock is not deleted automatically.
An interrupted process may require manual inspection and lock removal.

## Shared board

`swarm_board` stores shared facts for one run, such as the current base SHA, a
file ownership table, or cache-safety rules. Agents read it on demand instead of
relying on copies in their context.

```json
{"action":"write","key":"main.sha","value":"b4238eb"}
{"action":"read"}
{"action":"delete","key":"main.sha"}
```

`read` lists every entry, or one key. Each entry records its author, time, and
revision. Only the author or the author's ancestors can change or delete an
entry. Keys use 1-100 letters, digits, `_`, `.`, `/`, or `-`. Values are
limited to 8,000 characters, and a run holds at most 200 keys. Entries are
informational, like messages from other agents: they do not assign work, change
scope, or release permission. Workers can use the board during permission waits
and checkpoint holds.

## Reload barrier

Use a reload barrier to update running direct children without letting restart
instructions authorize new work:

1. Call `swarm_reload action=request`, optionally with `nodeIds`. Members must
   be running direct children with no pending replacement. A member's running
   descendants keep running through its restart; the member lists them in its
   checkpoint and manages them again after release. Reload them with the
   member's own barrier.
2. Each worker finishes only its existing bounded step, finishes or stops owned
   jobs, then calls `swarm_reload action=checkpoint` alone with `barrierId` and a
   self-contained `checkpoint`. Include dirty files, pinned bases, checks, and
   recovery details. This ends the worker turn and holds editing and new jobs.
3. After every member checkpoints, call `swarm_reload action=restart` with the
   barrier ID. It stops and restarts members without assigning new work. It
   checks both managed Bash tasks and tmux jobs. Unknown job ownership blocks
   checkpoint or restart instead of assuming no jobs.
   Restart refuses when the installed package differs from the package the
   parent loaded, because restarted workers would load the newer package. Reload
   the parent first, or pass `allowRevisionChange: true` and reload the parent
   before release.
4. Reload the parent too if its source is old. Read `action=status` until every
   member reports readiness from its new launch generation. Status shows the
   parent, installed, and per-member revisions. Ready workers remain on
   checkpoint hold. Matching source fingerprints are required for release. A
   release error names the side to reload. Call `action=restart` again on a
   ready barrier to restart only members whose revision differs from the
   parent's or whose process stopped.
5. Call `action=release` with one `{nodeId, task}` bounded assignment for every
   member. Release saves the new assignments, permissions, and steering messages
   atomically. Ordinary instructions cannot lift checkpoint holds.

Barrier state, checkpoints, and readiness survive recovery. Failed restarts retain
checkpoints and an error. Inspect the failure before retrying `action=restart`;
workers with live restarted sessions are not launched twice. `action=cancel` ends
an unreleased barrier. It returns each member's checkpoint, removes the members
from the barrier, and moves running members from checkpoint hold to a
`waiting-approval` wait. Then release them with an instruction, request a new
barrier, or restart stopped members with `swarm_restart`. The barrier does not
commit, merge, or discard work. Workers running old code cannot call the checkpoint
tool. Manually checkpoint and reload those sessions first; the barrier is not a
way to add tools to an already loaded old runtime.

## Git isolation

Dirty parents require an explicit `exclude`, `commit-parent`, `commit-child`, or
`shared` choice. The error lists up to 20 dirty paths. Shared/parent-commit modes reject `main` and `master`. Child
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
workers. `swarm_restart` keeps the worker's session and worktree. It reuses the
worker's reported current model and thinking level, then its launch settings and
fast-mode preference, then the parent's current settings. Supply `model` from
`swarm_models` or `thinking: "low"` (or `off`, `minimal`, `medium`, `high`,
`xhigh`, `max`) to override them. Restart refuses a live worker unless you pass
`stop: true`, which stops the worker and its jobs first. Descendants must already
be terminal. It does not restart old jobs.

`/swarm:status` shows or hides a compact panel below the editor. It lists
nonterminal workers under the current node as a tree. Each row shows the worker's
name, age since launch, and latest outgoing swarm message on one line. Names use
the theme's success color (green) for healthy workers, warning color (yellow) for
starts, waits, reviews, unknown state, or diagnostic warnings, and error color
(red) for missing panes or health-read errors. Errors take priority over warnings.
Status labels use the same warning and error colors; routine check-in labels stay
muted. Ages and separators stay dim, and message previews use normal text.
Tool events and incoming instructions do not replace the message preview. A worker
with no message shows its activity report, or "No messages yet". Review rows preview the
current handoff. The panel adds labels for check-ins, queued or delivered
instructions, starts, waits, review requests, and diagnostic warnings. Healthy
workers omit routine activity, released permission, matching source versions,
models, thinking levels, unread counts, and code-stage counts. Use `swarm_tree`
for full details; restarting a worker does not clear its handoff decision.
`swarm_restart` accepts an optional `task` for the next bounded assignment.
It saves that assignment before launch. `swarm_task.currentAssignment` exposes the
current task with appended instructions, explicit replacement, or restart assignment,
separate from `historicalHandoff`.
The original `node.task` remains available as context. Completed handoffs and their
feedback do not authorize a new task. If no current assignment exists, the worker
must ask the parent and wait. Instructions sent with `swarm_send` or
`swarm_broadcast` remain available after delivery and recovery; sending them does
not resume a review worker.

Workers report activity through `swarm_send` to their parent:
`activity: "working"`, `"waiting-instructions"`, or `"waiting-dependency"`.
The message text gives the reason. The tree exposes the report and timestamp.
A waiting report also sets the worker's permission to the matching wait until
the parent releases it. Report `working` to share status without a hold.
A waiting report that arrives before the worker reads a newer parent release
is delivered as a message only and does not undo that release.
Pi retries transient provider errors first, using its `retry` settings. If a
worker's turn still ends with a model error, such as an early end of the
provider stream, the worker records `errored` activity with the error and
resumes itself after 30 seconds, then 2 minutes, then 5 minutes. Each resume
tells the worker to check its assignment, files, and jobs and not to rerun
finished work. A new turn from any source cancels a pending resume. After three
failed resumes, the worker stays idle and its parent gets a health alert. The
next successful turn clears the state.
The panel shows activity labels and signal ages for check-ins, instructions,
and waits. Routine `working` and `tool-active` labels stay hidden. An ordinary
worker-to-parent message records `checking-in` when it has no explicit activity
report. Non-swarm tool checks record `tool-active`.
Parent instructions replace old waiting labels with `instruction-queued`, then
`instruction-delivered` when Pi accepts the instruction. Acknowledging an older
instruction cannot replace the state of a newer one. Recovery also corrects legacy
waiting reports when a newer matching parent instruction is present.
The tree identifies each signal's source. The panel retains the last message
across tool checks. Tool checks and check-ins do not prove useful progress,
completed tool execution, or instruction understanding. Reading swarm state alone
does not mark a worker tool-active. Workers should still explicitly report waits.
Activity with no report or observed event is `unknown`. Restart and completion clear
activity; a request for changes records a new queued instruction.
The parent prompt lists the three oldest pending direct-child reviews on each
new turn, plus the remaining count. `swarm_reviews` lists the full queue with
submission times, wait ages, review owners, overdue state, and parent-reported
integrated revisions. Each item also includes the owner's reminder state and
scheduled, queued, and delivered timestamps. Pass `nodeId` to inspect a full handoff. `/swarm:reviews`
offers inspect, accept, request-changes, and reject with feedback. Inspection
does not record a decision. The parent must still read the diff and evidence.

Handoffs become overdue after 300 seconds. While a direct-child backlog remains
overdue, the extension queues one aggregate steering reminder, even when other
session messages are pending. It lists up to three handoffs, oldest first, and
asks for explicit `swarm_review` decisions before follow-on assignments. A busy
parent receives it at a tool boundary; an idle parent gets a new turn. Only one
review reminder may remain queued in the current extension runtime. Pi's
`message_end` event confirms delivery to the conversation, not that the parent
read it or made a decision. The next reminder waits five minutes after delivery.
The status line shows scheduled, queued, or delivered state with timestamps;
`swarm_reviews` exposes the same state and the next scheduled time. There is no
pending-message deferral state because other messages do not block queueing.
Reminders do not cancel tools,
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

The active count includes workers paused for review. The header separates active,
`awaiting-parent`, and terminal counts with dim `|` characters. Active counts use
the accent color, pending review counts use the warning color, and terminal
counts stay muted because they include failures and stopped workers. Zero counts
stay dim. Review rows show `await-parent` in warning color.
Parents also receive a warning for each new handoff revision and a pending-review
status indicator with direct-child overdue and recorded-integration counts.
The header counts terminal workers, not completed code. Review rows include the
wait age, overdue warnings, and recorded integration with an undecided handoff.
Rows show "no pane" when the worker's tmux session is gone. The panel refreshes
every two seconds. It shows permission holds, unknown or mismatched source versions,
quiet-activity diagnostics, and health-read errors only when present.

Read-only tools work across the run. Any worker can call `swarm_observe` on
another worker, `swarm_health` with `nodeId` for that node and its descendants,
and `swarm_reviews` with `owner` or `nodeId` for another node's review queue or
handoff. Stop, restart, and review decisions stay with the direct parent.

`swarm_health` reports process presence, recent activity age, and owned managed
Bash tasks and tmux jobs. It distinguishes `quiet-with-job`, `quiet-no-job`,
`recent`, `awaiting-review`, `errored`, and `unknown`. Unknown job ownership includes the
read error. Quiet does not mean stalled, and a live job does not prove progress.
The extension checks every ten seconds. Once per warning episode, it sends the
direct parent's agent a steering message for a missing worker pane, an
`errored` worker whose automatic resumes ran out, or a quiet worker without a
known permission wait. An `errored` alert asks the parent to send the idle
worker a message to resume it. The message starts a turn for an idle
parent and asks it to inspect the worker and report what it did. A
`quiet-no-job` alert asks the parent to steer an idle worker and to stop or
restart only a stuck one. These alerts do not go to the user as notifications;
the panel still shows the state. A deeper worker's alert goes to its own parent.
Use `/swarm:quiet <seconds>` to change the branch's quiet threshold, default 300.
Diagnostics never stop or restart workers automatically.

While non-review direct children remain active, each parent receives a worker
check-in every five minutes. This steering message asks the parent to inspect
`swarm_health`, `swarm_tree`, and unclear worker output, then report progress
and the next check time. It starts a turn for an idle parent and reaches a busy
parent at a tool boundary. It lists up to ten workers with status, latest activity
report and age, nonreleased permission, reload stage, active job count and quiet
state from the last health check, and a missing pane. Only one check-in can remain queued. The next interval
starts when Pi reports message delivery, not when the parent acts. Permission
waits remain in force. Check-ins do not cancel a running tool or prove that the
parent inspected workers. Reload starts a new five-minute interval.

Tool results display plain-text previews. Expand a result to see all fields;
structured result data is unchanged.

Tests cover temporary Git repositories, isolated tmux servers with fake workers,
real Pi worker shutdown, concurrent state writes, direct cross-branch messaging,
same-run routing, parent-only authority, permission-preserving peer messages, review
pauses, prompt injection, model reporting/filtering, independent delivery
records, replacement of committed and dirty work, reload barrier recovery,
explicit permissions, repeated and concurrent appended instructions, explicit task
replacement, atomic append rejection after completion, age-ordered reviews,
bounded recurring review reminders,
integrated-but-undecided indicators, and read-only job diagnostics. Launch tests make no model
requests. End-to-end interactive orchestration and recovery audits remain pending.
