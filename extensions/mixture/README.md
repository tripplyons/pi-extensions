# Mixture

Mixture is a native Pi model with a lead, a writer and independent read-only
reviewers. Select `mixture/default` through `/model`. Requires Pi 0.85.1 or newer.
Selecting an ordinary model does not start collaborators.

The writer receives each complete user request first, then plans, edits and tests
in your current checkout, including uncommitted and untracked files. The lead
uses Astra after the writer reports to assess evidence, resolve ambiguity, direct
corrections and answer the user. This keeps routine investigation on the cheaper
model. No Git repository, worktree or editing subprocess is required. The lead
can explicitly take over after a safe writer handoff.

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
coordinates delegation, reports and takeover; it is active only in Mixture.
Controls cannot share a batch with other tools. Unknown effectful tools require
the writer lease. Nested editing-agent launches and execution while attached to
a managed swarm are blocked.

Reviewers have separate histories and only Pi's native `read`, `grep`, `find`
and `ls`, plus a structured reporting operation. Their private reads use those
read-only implementations, not the outer editing-tool loop. Reviewers cannot
run shell commands or call arbitrary extension tools. This is not an OS sandbox.

Reviewers receive delegation constraints and completed execution deltas. Briefs,
reads, edits and test evidence are queued without spending a request. Review
starts only at a completed writer-report boundary, where each configured reviewer
gets at most one grouped read batch before its required structured report.
Findings carry model identity, severity, evidence and the execution revision.
Concerns and blockers are reconfirmed before asking the lead to act. Reviewers
audit each explicit criterion but treat optional generality outside the task as
a nit at most. Review is advice, not a vote or user authority.

The default preset uses one reviewer. At the writer-report boundary, the lead may
request a correction, dismiss advice with reasons, or take over. A candidate
final answer is withheld until bounded final review completes. When the checkout
revision already has a clean completed review, candidate review is a single
report-only request rather than another file-reading batch.
Failed or incomplete review is disclosed, never counted as clean. Remaining
serious findings are disclosed when correction rounds are exhausted.

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
| `requestTimeoutMs` | 240000 | Each underlying request, including auth |
| `writerTurns` | 32 | Responses per delegation, including context recovery |
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
limit stops the affected operation with an explicit reason. Provider retries
default to zero.

## Sessions, context and usage

Versioned custom entries in the current Pi session hold role histories, findings,
counters, usage receipts and writer ownership. They are not injected into the
main model context. Ephemeral sessions remain ephemeral. No global daemon,
private credential copy or separate run directory is created.

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
starting collaborators.

Usage receipts preserve underlying model identities and charge completed calls
once, including summaries, failed calls that report usage and rejected final
candidates. Nested calls are carried by native control-tool results; cancellation
can carry unreported usage on an aborted/error assistant receipt. These do not
inflate the main context-pressure estimate. Clean-footer includes tool-result,
compaction and branch-summary costs.

An abruptly terminated request may have unknown provider usage. Persisted but
not yet delivered receipts remain pending until the next accounting boundary.
Neither missing usage nor zero configured model prices prove that a call was free.

## Inspection

- `/mixture` or `/mixture status`: roster, ownership, review state and usage.
- `/mixture inspect`: scrollable details in the TUI; textual status outside it.
  Inspection includes per-role request latency and writer-report/final-review wait
  totals for runtime tests and performance comparisons.
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
