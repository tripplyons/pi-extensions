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
coordinates delegation, in-flight writer updates, reports and takeover; it is active only in Mixture.
Controls cannot share a batch with other tools. Its schema exposes only actions
valid for the current role and lease: writer report/escalation, lead steering
update/takeover, or lead delegation/takeover. Unknown effectful tools require the writer lease. This includes extension tools
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
writer tool batches and coalesces newer evidence while a review is running.
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
of allowing an unbounded local correction stall; a new delegation renews the
counter. Models supply briefs, work and judgments, but cannot change the review cadence or
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
withheld until bounded final review completes. When the checkout revision already
has a clean completed review, writer-completion and candidate reviews use a single
report-only request rather than another file-reading batch.
Failed or incomplete review is disclosed, never counted as clean. A structured
incomplete report may explicitly resolve an earlier finding it rechecked; findings
without an explicit disposition remain open. This prevents an unrelated missing
check from pinning already-corrected advice forever.

Images remain available to roles that support them. Text-only roles receive an
explicit omitted-image warning; their review must not be treated as visual
verification. Composite input metadata reflects the whole roster conservatively.

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
| `writerRequestTimeoutMs` | 240000 | Each writer request, including auth |
| `writerTurns` | 32 | Responses per delegation, including context recovery |
| `reviewEveryBatches` | 3 | Completed writer tool batches per scheduled background review |
| `leadEveryReviews` | 3 | Scheduled review cycles per forced lead checkpoint |
| `reviewerBatchTurns` | 2 | Requests per reviewer batch |
| `catchUpMs` | 120000 | Checkpoint review deadline |
| `leadMaxTokens` | 16384 | Lead output ceiling |
| `writerMaxTokens` | 8192 | Writer output ceiling |
| `reviewerMaxTokens` | 8192 | Reviewer output ceiling |
| `maxCostUsd` | unset | Estimated admission cap for the role-state lifetime |

Output limits are clamped to each provider's model limit. Steering does not reset
request limits. Lead-to-writer delegations, reviewer batches across checkpoints,
and final-answer correction cycles have no cumulative cap, so iterative loops can
continue until completion or cancellation. In-flight estimated costs are reserved
before admitting another request, including concurrent reviewers. Estimates use
configured model prices; they are not guaranteed billing ceilings. A configured
limit stops the affected operation with an explicit reason. A zero-output writer
connection or request-timeout failure gets at most one same-role retry per
delegation before the harness escalates it to the lead. Retrying never runs a tool,
rolls back files, or resets the writer history: only a request that produced no
output and no tool call is eligible. Other provider failures are not retried here.

## Sessions, context and usage

Versioned custom entries in the current Pi session hold role histories, findings,
counters, usage receipts and writer ownership. A lifecycle starts with one full
snapshot; later checkpoints store content-addressed deltas and periodically start
a new snapshot chain. A snapshot is also used whenever it is smaller. This avoids
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
  Inspection includes per-role request latency and separate periodic, escalation,
  completion-report and final-review wait totals for runtime comparisons.
- Expand coordination tool cards for findings and per-role usage.
- The compact status uses Pi's status API and works alongside clean-footer.

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
