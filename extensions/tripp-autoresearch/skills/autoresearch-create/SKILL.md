---
name: autoresearch-create
description: Prepare or run an autonomous experiment loop for any optimization target. Honors setup-only handoffs when the user wants to start the loop manually. Use when asked to "run autoresearch", "optimize X in a loop", "set up autoresearch for X", or "start experiments".
---

# Autoresearch

Autonomous experiment loop: try ideas, keep what works, discard what doesn't, never stop.

## Tools

- **`init_experiment`** — configure session (name, metric, unit, direction). Call again to re-initialize with a new baseline when the optimization target changes.
- **`run_experiment`** — runs command, times it, captures output.
- **`log_experiment`** — records result. `keep` auto-commits. `discard`/`crash`/`checks_failed` auto-reverts code changes (autoresearch files preserved). Always include secondary `metrics` dict. Dashboard: ctrl+shift+t.

## Session boundary

Starting a loop and finalizing its results are separate jobs.

- If the user asks to run or start autoresearch, create the research branch, write the session files, initialize the tools, record the untouched baseline, and begin the first candidate.
- If the user says they will start it manually, asks for setup only, or reserves the loop for themselves, prepare a clean handoff instead. Create the branch and session files, commit them, and run `.auto/measure.sh` once to prove the benchmark works. Do not call `init_experiment`, create `.auto/log.jsonl`, edit a candidate, activate autoresearch mode, or start the loop.
- Leave the research branch and `.auto/` state intact for the user. A `keep` commit is an experiment result, not finalization.
- Never run `autoresearch-finalize`, split results into review branches, merge them, return to trunk, or clean up the session unless the user explicitly asks to finalize.
- If the user asks for a tracked goal, match that boundary. A setup-only goal ends at the clean handoff. A running-loop goal excludes finalization.

## Session files

All session files live in a single `.auto/` subfolder at the working directory root. This keeps everything in one place — easy to preserve across reverts, gitignore, and clean up.

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | Experiment prompt / playbook (heart of the session) |
| `.auto/measure.sh` | Benchmark script — emits `METRIC name=value` lines |
| `.auto/log.jsonl` | Append-only result log (written by the tools) |
| `.auto/ideas.md` | Ideas backlog (optional) |
| `.auto/checks.sh` | Correctness checks (optional) |
| `.auto/config.json` | Session config (optional) |
| `.auto/hooks/{before,after}.sh` | Lifecycle hooks (optional) |

> Always create files in the `.auto/` layout. Legacy flat `autoresearch.*` files are still read for in-flight sessions, but new sessions should use `.auto/`.

## Jump-climb: make the largest plausible improvement at each scale

Use this benchmark-winning strategy throughout setup and every later iteration:

1. **Measure the untouched incumbent.** Run the baseline through `run_experiment` and record it with `log_experiment` before editing code. Treat the best kept result as the incumbent after that.
2. **Find the biggest plausible jump.** At every step, ask which valid change could improve the primary metric the most. Rank ideas by plausible relative improvement, not ease of implementation. Test the highest-impact viable idea first.
3. **Search widely at the start.** Early in optimization, consider broad and varied changes. The largest gains often come from replacing the construction, representation, algorithm, or strategy. Do not limit the search to variations of the incumbent when a different approach could make a larger jump.
4. **Narrow with the score.** After every kept improvement, make it the new incumbent and search again for the biggest remaining jump. Expect the useful scope to narrow over time: structural replacements first, then component changes and simplifications, then local refinements when larger gains no longer look credible. Let measured progress determine this transition. Do not preselect a number of jumps or phases.
5. **Keep only new bests.** Run every candidate through `run_experiment`, including `.auto/checks.sh` when configured, then call `log_experiment`. Use `keep` only when correctness passes and the primary metric strictly improves on the incumbent. Otherwise use `discard`, `crash`, or `checks_failed`; `log_experiment` restores the incumbent. Correctness is absolute.
6. **Use rejected work as evidence.** Record the idea, measured result, and failure reason in `asi` and the session files. Never repeat a rejected idea unchanged. Try the next highest-impact distinct idea.
7. **Keep climbing.** Continue until interrupted or `maxIterations` stops the session. If no credible improvement is obvious, re-read the source and measurements, widen the search, and choose a structurally different idea instead of ending the loop.

## Setup

1. Ask (or infer): **Goal**, **Command**, **Metric** (+ direction), **Files in scope**, **Constraints**.
2. `git checkout -b autoresearch/<goal>-<date>`
3. Read the source files. Understand the workload deeply before writing anything.
4. `mkdir -p .auto`, then write `.auto/prompt.md` and `.auto/measure.sh` (see below). Commit both.
5. Run `.auto/measure.sh` once to prove that it produces valid metrics and exercises the intended workload.
6. Follow the user's handoff boundary:
   - **Setup only / manual start**: restore any benchmark side effects, confirm the tree is clean, and stop. Do not initialize or create `.auto/log.jsonl`. Tell the user to start the prepared session with `/autoresearch start the prepared loop`.
   - **Run / start now**: `init_experiment` → run baseline through `run_experiment` → `log_experiment` → start looping immediately.

### `.auto/prompt.md`

This is the heart of the session. A fresh agent with no context should be able to read this file and run the loop effectively. Invest time making it excellent.

```markdown
# Autoresearch: <goal>

## Objective
<Specific description of what we're optimizing and the workload.>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better) — the optimization target
- **Secondary**: <name>, <name>, ... — independent tradeoff monitors

## How to Run
`./.auto/measure.sh` — outputs `METRIC name=number` lines.

## Files in Scope
<Every file the agent may modify, with a brief note on what it does.>

## Off Limits
<What must NOT be touched.>

## Session Boundary
Leave this branch and `.auto/` intact for the user. Do not finalize, split, merge,
return to trunk, or clean up unless the user explicitly asks.

## Constraints
<Hard rules: tests must pass, no new deps, etc.>

## What's Been Tried
<Update this section as experiments accumulate. Note key wins, dead ends,
and architectural insights so the agent doesn't repeat failed approaches.>
```

Update `.auto/prompt.md` periodically — especially the "What's Been Tried" section — so resuming agents have full context.

### `.auto/measure.sh`

Bash script (`set -euo pipefail`) that: pre-checks fast (syntax errors in <1s), runs the benchmark, and outputs structured lines to stdout. Keep the script fast — every second is multiplied by hundreds of runs.

**For fast, noisy benchmarks** (< 5s), run the workload multiple times inside the script and report the median. This produces stable data points and makes the confidence score reliable from the start. Slow workloads (ML training, large builds) don't need this — single runs are fine.

#### Structured output

- `METRIC name=value` — primary metric (must match `init_experiment`'s `metric_name`) and any secondary metrics. Parsed automatically by `run_experiment`.

#### Design the script to inform optimization

The script should output **whatever data helps you make better decisions in the next iteration.** Think about what you'll need to see after each run to know where to focus:

- Phase timings when the workload has distinct stages
- Error counts, failure categories, or test names when checks can fail in different ways
- Memory usage, cache hit rates, or other runtime diagnostics when relevant
- Anything domain-specific that would help localize regressions or identify bottlenecks

The script runs the same code every iteration — but you can **update it during the loop** if you discover you need more signal. Add instrumentation as you learn what matters.

#### Agent-supplied ASI via `log_experiment`

Use `log_experiment`'s `asi` parameter to annotate each run with **whatever would help the next iteration make a better decision.** Free-form key/value pairs — you decide what's worth recording. Don't repeat the description or raw output; capture what you'd lose after a context reset.

**Annotate failures and crashes heavily.** Discarded and crashed runs are reverted — the code changes are gone. The only record that survives is the description and ASI in `.auto/log.jsonl`. If you don't capture what you tried and why it failed, future iterations will waste time re-discovering the same dead ends.

### `.auto/config.json` (optional)

JSON config file that lives in `.auto/` under the pi session's working directory (`ctx.cwd`). Supported fields:

- **`maxIterations`** (number) — maximum experiments before auto-stopping.
- **`workingDir`** (string) — override the directory for all autoresearch operations: file I/O (`.auto/log.jsonl`, `.auto/prompt.md`, `.auto/measure.sh`, `.auto/checks.sh`, `.auto/ideas.md`), command execution, and git operations. Supports absolute paths or relative paths (resolved against `ctx.cwd`). The config file itself always stays under `ctx.cwd`. Fails if the directory doesn't exist.

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50
}
```

### `.auto/checks.sh` (optional)

Bash script (`set -euo pipefail`) for backpressure/correctness checks: tests, types, lint, etc. **Only create this file when the user's constraints require correctness validation** (e.g., "tests must pass", "types must check").

When this file exists:
- Runs automatically after every **passing** benchmark in `run_experiment`.
- If checks fail, `run_experiment` reports it clearly — log as `checks_failed`.
- Its execution time does **NOT** affect the primary metric.
- You cannot `keep` a result when checks have failed.
- Has a separate timeout (default 300s, configurable via `checks_timeout_seconds`).

When this file does **not** exist, everything behaves exactly as before — no changes to the loop.

**Keep output minimal.** Only the last 80 lines of checks output are fed back to the agent on failure. Suppress verbose progress/success output and let only errors through. This keeps context lean and helps the agent pinpoint what broke.

```bash
#!/bin/bash
set -euo pipefail
# Example: run tests and typecheck — suppress success output, only show errors
pnpm test --run --reporter=dot 2>&1 | tail -50
pnpm typecheck 2>&1 | grep -i error || true
```

## Loop Rules

**LOOP FOREVER.** Never ask "should I continue?" — the user expects autonomous work.

- **Primary metric is king.** Improved → `keep`. Worse/equal → `discard`. Secondary metrics rarely affect this.
- **Annotate every run with `asi`.** Record what you learned — not what you did. What would help the next iteration or a fresh agent resuming this session?
- **Watch the confidence score.** After 3+ runs, `log_experiment` reports a confidence score (best improvement as a multiple of the session noise floor). ≥2.0× means the improvement is likely real. <1.0× means it's within noise — consider re-running to confirm before keeping. The score is advisory — it never auto-discards.
- **Crashes:** fix if trivial, otherwise log and move on. Don't over-invest.
- **Resuming:** if `.auto/prompt.md` exists, read it + git log, continue looping.

**NEVER STOP.** The user may be away for hours. Keep going until interrupted.

## Ideas Backlog

When you discover complex but promising optimizations that you won't pursue right now, **append them as bullets to `.auto/ideas.md`**. Don't let good ideas get lost.

On resume (context limit, crash), check `.auto/ideas.md`, prune stale or tried entries, and experiment with the rest. If the backlog runs dry, search for a structurally different idea. Do not delete session state or finalize the branch.

## User Messages During Experiments

If the user sends a message while an experiment is running, finish the current `run_experiment` + `log_experiment` cycle first, then incorporate their feedback in the next iteration. Don't abandon a running experiment.
