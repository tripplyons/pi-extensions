# Mixture

Mixture is a native Pi model with a lead, a writer and independent read-only
reviewers. Select `mixture/default` through `/model`. Requires Pi 0.85.1 or newer.
Selecting an ordinary model does not start collaborators.

The lead receives each complete user request first, settles consequential choices,
defines a concrete plan, constraints and acceptance criteria, and initiates the
writer. The writer then plans, edits and tests in your current checkout, including
uncommitted and untracked files. The
harness schedules read-only review during that work and delivers findings directly
to the writer. It returns control to the lead less often for strategy, ambiguity,
completion assessment and the user-facing answer. No Git repository, worktree or
editing subprocess is required. The lead can explicitly take over after a safe
writer handoff.

## Configuration

`/mixture configure [preset]` selects available models and thinking levels, lets
you edit the complete proposal, and saves only after confirmation. Type in a TUI
model picker to filter by provider/model rather than scrolling the whole catalog.
It requires an idle interactive session and reconciled background jobs. Cancelling changes
nothing. Concurrent file edits abort the save rather than overwrite them.
Select another model before removing the active preset.

Configuration lives at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/mixture.json`:

```json
{
  "version": 2,
  "presets": {
    "default": {
      "lead": "openai-codex/gpt-6-astra",
      "writer": {
        "model": "openrouter/z-ai/glm-5.3-flash",
        "thinking": "low"
      },
      "reviewers": [
        { "model": "openrouter/z-ai/glm-5.3-flash", "thinking": "low" }
      ]
    }
  }
}
```

- A missing file uses these defaults in memory; startup does not write it.
- Preset names become model IDs: `mixture/<preset>`.
- Set `reviewers` to `[]` to disable independent review. Up to four are allowed.
- Each writer/reviewer can have optional `guidance`. Repository instructions
  already supplied to Pi are included; no additional project config is loaded.
- Lead thinking follows Pi's normal selector. Writer/reviewer levels are
  validated separately. Recursive `mixture/*` role models are rejected.
- Credentials stay in Pi. Each request resolves its own effective provider,
  authentication, headers and endpoint, including provider overrides.
- An explicit session `/fast` override is inherited by every `openai-codex`
  role request. Untoggled sessions leave the provider's existing tier unchanged.
- Role models must be present in Pi's catalog or model configuration. Discovery
  does not fetch missing metadata or make inference calls. Missing models and
  unsupported thinking levels produce diagnostics, not substitute models.
- Malformed and legacy files are preserved and reported with their path.
  There is no automatic migration. Explicitly configure a new version-2 file.

## Execution and review

Lead and writer calls use the normal Pi tool loop, including validation,
permission hooks, visible tool output and recorded results. `mixture_control`
coordinates delegation, phase assessment, in-flight writer updates, reports and takeover; it is active only in Mixture.
Controls cannot share a batch with other tools. Its schema exposes only actions
valid for the current role and lease: writer report/escalation, lead steering
update/takeover, or lead delegation/assessment/takeover. Unknown effectful tools require the writer lease. This includes extension tools
such as autoresearch and image generation; Mixture does not maintain an allowlist
that silently hides newly installed writer tools. Conversation-level goal creation
and completion remain with the lead. Nested editing-agent launches and execution
while attached to a managed swarm are blocked.

Reviewers have separate histories and only Pi's native `read`, `grep`, `find`
and `ls`, plus a structured reporting operation. Their private reads use those
read-only implementations, not the outer editing-tool loop. Reviewers cannot
run shell commands or call arbitrary extension tools. This is not an OS sandbox.

Reviewers receive delegation constraints and completed execution deltas. The
harness starts a tactical background review every `reviewEveryBatches` completed
writer batches that advance the execution revision. Read-only batches are retained as
evidence for the next scheduled or checkpoint review but do not advance the cadence.
Newer evidence coalesces while a review is running, and each request retains at most
the latest eight distinct images.
Incremental cycles focus on changed evidence and unresolved findings; completion
and handoff checkpoints audit the full scope. Completed findings are inserted into
the writer's private history automatically. The writer corrects supported findings
without a lead round trip, and later review must explicitly recheck them. New user
steering pauses inference at a model boundary for lead assessment, then the lead
injects one consolidated update into the existing writer context without starting
a replacement phase.

After `leadEveryReviews` completed scheduled review cycles, the harness snapshots
current findings plus a bounded tool/status milestone digest at a safe tool
boundary and transfers control to the lead without starting a redundant review.
Completion reports, unresolved escalations and review failures can cause an
earlier checkpoint. A completion report with supported concerns is withheld so
the reviewer can return them directly to the writer. After three rejected
completion reports in one delegation, the harness forces lead assessment instead
of allowing an unbounded local correction stall. A new delegation renews that
local report counter, but not the phase's failed-correction history described below.
Models supply briefs, work and judgments, but cannot change the review cadence or
bypass lease and handoff checks. If the lead takes over editing, each
mutation batch requests a review as well; requests coalesce while the reviewer is
busy so final review can overlap the lead's correction work.

Tactical cycles report from the supplied execution deltas in one request. Full
completion and handoff audits get at most one grouped native-read batch before
their required structured report. Afterward, reviewer model history is reduced to
the task scope and
authoritative unresolved findings; obsolete tool transcripts and resolved IDs do
not inflate later cycles. Findings carry model identity, severity, evidence and the
execution revision. Reviewers audit each explicit criterion but treat optional
generality outside the task as a nit at most. Review is advice, not a vote or user
authority. The default preset uses one reviewer. A candidate final answer is
withheld until bounded final review completes. When the execution revision already
has a clean completed review, writer-completion and candidate reviews use a single
report-only request rather than another file-reading batch.
Failed or incomplete review is disclosed, never counted as clean. A structured
incomplete report may explicitly resolve an earlier finding it rechecked; findings
without an explicit disposition remain open within the current phase. Starting a
fresh phase clears the closed phase's findings and private review context while
preserving cumulative usage and request accounting. Continuations of the same
phase keep their findings.

A serious final-review result can trigger two lead reassessments at the same
execution revision. If serious findings remain after both, the harness releases the
next candidate with those findings attached instead of spending indefinitely
without new execution evidence. A new effectful-tool revision renews the
reassessment allowance, so productive correction work remains unbounded.

Images remain available to roles that support them. Text-only roles receive an
explicit omitted-image warning; their review must not be treated as visual
verification. Composite input metadata reflects the whole roster conservatively.

## Handoffs and stalled work

Each delegation separates the concrete `nextAction` from `acceptedEvidence`
(facts and checks not to repeat), standing `constraints`, and `successCriteria`.
A phase retains at most 16 normalized standing constraints; continuations inherit
them and add only distinct entries. An optional `immediateAction` names the first
writer tool and explains why it must run before other tool exploration. A mismatched
tool call is blocked, while writer reporting and escalation remain available.
The original phase outcome and acceptance remain in every continuation brief,
even when the next step is smaller. User steering is retained across continuations.

For example, the lead can start with:

```json
{
  "action": "delegate",
  "task": "Fix foreground cancellation without stopping persistent jobs",
  "nextAction": "Add the missing abort subscription and run the process-boundary regression",
  "acceptedEvidence": ["The signal reaches the tool but not the foreground child"],
  "constraints": ["Do not stop unrelated or already-persistent jobs"],
  "successCriteria": ["Foreground child exits on Escape", "Persistent job survives"]
}
```

At a writer handoff, the lead calls `assess` with the harness's `phaseId`, an
`assessment`, and concrete `evidence` before delegating again:

- `progress`: a criterion advanced or an uncertainty was resolved. Useful
  read-only diagnosis counts; repeated reads or edits alone do not prove progress.
- `stalled`: the attempt did not advance the outcome. Name the repeated behavior
  or unresolved obstacle in the evidence.
- `blocked`: execution needs a changed prerequisite. Also supply `blocker`.
- `complete`: the phase criteria are met, with evidence.
- `superseded`: the user cancelled or replaced the phase. Cite that direction;
  do not use this to hide unfinished obligations.

An attempt receives at most one progress/stalled/blocked assessment. The separate
assessment call saves its result before another delegation can be rejected.
Completion or user-directed supersession can also close work finished by the lead.

The initial stalled attempt allows correction 1. If correction 1 stalls, correction
2 is allowed. If correction 2 also stalls, another equivalent delegation is
rejected. Progress resets the consecutive failed-correction count, not its audit
history. A blocked assessment stops delegation immediately.

The lead can take over, ask for a required decision, or report the concrete blocker.
To resume the same stalled/blocked phase, `delegate` must include its `phaseId`
and `changedPrerequisite: { "change": "...", "evidence": "..." }`. This starts an
ordinary attempt with a reset streak while retaining the reason and prior history.
A renamed task, urgency instruction, new user message, or reload does not reset it.
Starting another phase requires completing or explicitly superseding the old one.

The harness enforces recorded decisions, not their semantic truth. The lead must
judge whether evidence actually shows progress or a changed prerequisite. It can
still make that judgment incorrectly. This policy does not guarantee faster or
better live-model execution.

`nextAction` is required and limited to 4,000 characters. Evidence, blocker and
prerequisite strings are limited to 2,000 characters each. `acceptedEvidence`
allows up to eight nonempty entries. Oversized or blank supplied values are
rejected. Phase state retains the latest eight assessment/prerequisite records
plus independent counters, so trimming history cannot grant more retries.

## Background jobs and cancellation

A tracked running shell job retains its role's writer lease. Handoff, takeover
and final completion wait for current-session jobs to finish or be explicitly
stopped. Blocked transitions identify job IDs. A paused writer cannot make more
model calls; the lead may inspect or stop its tracked job before taking over.

A missing or failed bg-bash ownership query fails closed when that integration
has been used. Restore bg-bash to reconcile retained jobs if it was disabled.
Without bg-bash, only synchronous shell execution supports managed handoff.
Mixture does not infer that an unknown background tool has finished.

Cancellation and model/session changes abort inference, not surviving shell
jobs. Mixture warns about those jobs; it does not kill them to force a handoff.
The guarantee covers Mixture-controlled roles and tracked jobs, not human edits,
other Pi sessions or unmanaged detached descendants. Instructions prohibit
intentionally detaching a writing process.

## Limits

Each preset accepts a `limits` object. Omitted fields use these defaults:

| Field | Default | Scope |
| --- | ---: | --- |
| `requestTimeoutMs` | 240000 | Each lead or reviewer request, including auth |
| `writerRequestTimeoutMs` | 240000 | Absolute ceiling for each writer request, including auth |
| `writerIdleTimeoutMs` | 240000 | Writer silence deadline, reset by provider stream activity |
| `writerTurns` | 32 | Responses per delegation, including context recovery |
| `reviewEveryBatches` | 3 | Writer batches that advance execution revision per scheduled background review |
| `leadEveryReviews` | 3 | Scheduled review cycles per forced lead checkpoint |
| `reviewerBatchTurns` | 2 | Requests per reviewer batch |
| `catchUpMs` | 120000 | Checkpoint review deadline |
| `leadMaxTokens` | 16384 | Lead output ceiling |
| `writerMaxTokens` | 8192 | Writer output ceiling |
| `reviewerMaxTokens` | 8192 | Reviewer output ceiling |
| `maxCostUsd` | unset | Estimated admission cap for the role-state lifetime |

Output limits are clamped to each provider's model limit. Steering does not reset
request limits. Writer stream activity renews only the idle deadline; the absolute
writer ceiling and outer cancellation remain authoritative. Lead-to-writer
delegations and reviewer batches across checkpoints have no cumulative cap.
Productive iterations can continue, but equivalent stalled delegations are subject
to the phase gate and unchanged-revision final reassessment is bounded as described
above. In-flight estimated costs are reserved
before admitting another request, including concurrent reviewers. Estimates use
configured model prices; they are not guaranteed billing ceilings. A configured
limit stops the affected operation with an explicit reason. A zero-output writer
connection or request-timeout failure gets at most one same-role retry per
delegation before the harness escalates it to the lead. Retrying never runs a tool,
rolls back files, or resets the writer history: only a request that produced no
output and no tool call is eligible. Other provider failures are not retried here.

## Sessions, context and usage

Versioned custom entries in the current Pi session hold role histories, findings,
counters, phase assessments, usage receipts and writer ownership. A lifecycle starts with one full
snapshot; later checkpoints store content-addressed deltas and periodically start
a new snapshot chain. Image bytes are stored once per active branch as immutable
content-addressed blob entries; checkpoint histories contain references and hydrate
them during restore. Unchanged-state request stages use lightweight hash markers.
Array prefix removal uses compact splice deltas, and a snapshot replaces any delta
that reaches half its size. This avoids
repeatedly appending the complete role history while keeping restore work bounded.
Superseded reviewer-feedback and lead-progress notes are replaced by their current
authoritative form instead of accumulating across cycles. Lifetime scheduling,
feedback, lead-checkpoint, and escalation counters remain in bounded checkpoint
audit metadata. Checkpoints are not injected into the main model context. Ephemeral
sessions remain ephemeral. No global daemon, private credential copy or separate
run directory is created.

Reload/resume restores the active branch's valid checkpoint. Model/preset changes,
new sessions, forks, tree navigation and compaction invalidate stale work.
Restoration returns decisions to the lead and requires inspecting current files.
It does not roll files back or replay an interrupted write. A missing tool result
is recorded as interrupted: the operation may already have changed files.

Phase identity, assessment and failed-correction counts survive request boundaries,
abort, reload and compaction. Forks and tree navigation restore the selected branch's
phase state, not future or sibling decisions. Existing v2 state and v3 snapshot/delta
records remain readable. A legacy checkpoint without phase tracking adopts its old
brief as unresolved work with explicitly unknown earlier correction history;
counting starts from the observed boundary. Different cwd/preset restoration still
starts fresh contexts under the existing compatibility checks.

Each role compacts its own context with the same model, preserving task facts,
unresolved advice, images and recent complete tool batches. Recognized context
overflow gets one bounded recovery attempt. Failed summaries preserve the last
valid history. After Pi compacts the root session, Mixture rebases the lead on
that compacted context instead of retaining the larger pre-compaction history.
Pi's own compaction and other helper requests use the lead alone, without
starting collaborators. When the root request settles or detaches, Mixture
releases each nested native provider session resource while retaining role history.

Usage receipts preserve underlying model identities and charge completed calls
once, including summaries, failed calls that report usage and rejected final
candidates. Completed nested calls are carried by the following native tool result,
including coordination results; cancellation can carry unreported usage on an
aborted/error assistant receipt. Successful outer messages expose a context-only
lead estimate while their billable token components remain zero. Nested role token
counts therefore do not inflate the main context-pressure estimate, and Pi can
still distinguish the composite's live lead context from stale pre-compaction
usage. Clean-footer includes tool-result,
compaction and branch-summary costs.

An abruptly terminated request may have unknown provider usage. Persisted but
not yet delivered receipts remain pending until the next accounting boundary.
Neither missing usage nor zero configured model prices prove that a call was free.

## Inspection

- `/mixture` or `/mixture status`: roster, ownership, review state and usage.
- `/mixture inspect`: scrollable details in the TUI; textual status outside it.
  Inspection includes the durable phase assessment, blocker and correction count,
  per-role request latency, and separate periodic, escalation, completion-report
  and final-review wait totals.
- Collapsed lead tool cards show the action plus one message-preview line:
  `delegate` shows the next action (or the task on older calls), `update` shows
  the lead's message, and `assess` shows the assessment and its evidence.
  Previews flatten whitespace and stop at 160 display columns or the available
  width, with an ellipsis when clipped. The tool's result or error remains below.
- Expand a coordination card to read the full handoff fields, accepted evidence,
  constraints and completion checks, followed by findings and per-role usage.
  Previews work while arguments stream and when session history is restored.
  Other tools' rendering is unchanged.
- The Mixture footer section shows only `role · activity · $cost`, for example
  `writer · working · $0.024`. The rest of clean-footer stays unchanged: project,
  model, thinking, context pressure, session cost and other extension statuses.
  Mixture's cost includes its lead, writer and reviewers, including their context
  summaries. It excludes Pi's root compaction and other non-Mixture session usage;
  those still contribute to the separate session-cost figure.
- Activity follows the execution state: `planning`, `working`, `assessing`,
  `reviewing`, `finishing`, `blocked`, `compacting` or `idle`. A blocking review
  wait shows `reviewer`; concurrent background review does not replace the active
  lead/writer role. A recorded blocker or exhausted correction budget stays visible
  across idle and reload until the phase is resolved or the lead takes over.
  Live activity is not restored as if inference were still running.
- Revision numbers, review queue counts and warnings remain in inspection and
  expanded tool cards rather than the footer. The status uses Pi's status API;
  clean-footer keeps its existing narrow-terminal wrapping.

The legacy background tools, supervisors and worktree interfaces are removed.
Existing external artifacts are left alone; no old processes are stopped or
user files deleted by this extension.

## References

- [pi-moa](https://pi.dev/packages/pi-moa): named model configuration and labeled
  contributions. Mixture uses native model selection rather than its command pipeline.
- [pi-omplike-advisor](https://github.com/pasky/pi-omplike-advisor): persistent
  read-only reviewers, incremental updates, severity and reconfirmation.
- [Cognition local Fusion](https://cognition.com/blog/local-fusion): separate lead
  and sidekick contexts with briefs, reports and lead-owned decisions.

These informed the design; their runtime code is not bundled. Mixture makes no
claim to reproduce their benchmark results or savings.
