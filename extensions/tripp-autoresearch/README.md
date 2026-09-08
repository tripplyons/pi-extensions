# Autoresearch

Run optimization experiments: change code, measure it, keep improvements, and
revert regressions. Example targets include test runtime, bundle size, and
training loss.

Included in [pi-extensions](../../README.md#install), with its skills and assets.
Do not also install the upstream npm package; it registers the same tools.

## Start a loop

Run `/skill:autoresearch-create` and describe your objective, benchmark, and files
in scope. The agent prepares the benchmark, measures a baseline, and starts
experiments.

For preparation without experiments, ask for **setup only**. Start it later with:

```text
/autoresearch start the prepared loop
```

Loops modify files, create commits, and make model requests. Use a dedicated
branch and configure provider spending limits.

The active prompt requires explicit experiment and check timeouts based on
healthy wall-clock durations, usually about twice the baseline. For unknown
workloads, it starts with a 60-second experiment deadline unless there is evidence
for a longer run. It also requires bounded subprocesses and remote-job cleanup.
Timeouts trigger failure diagnosis rather than automatic retries with longer limits.

## Commands

| Command | Use |
| --- | --- |
| `/autoresearch start <goal>` | Set up a loop or resume an existing one with a goal. |
| `/autoresearch resume [context]` | Resume the saved loop, optionally adding instructions. |
| `/autoresearch pause` | Stop automatic continuation; keep results. |
| `/autoresearch clear` | Delete the experiment log and reset the loop. |
| `/autoresearch dashboard` | Open the live results dashboard in a browser. |

Press Escape to interrupt a running turn. Use `/autoresearch pause` to leave loop mode.

## Skills and tools

| Feature | Use |
| --- | --- |
| `/skill:autoresearch-create` | Prepare or start a loop. |
| `/skill:autoresearch-finalize` | Turn kept changes into separate review branches. Run explicitly when ready. |
| `/skill:autoresearch-hooks` | Add research, notifications, or other iteration hooks. |
| `init_experiment` | Set the metric, unit, and optimization direction. |
| `run_experiment` | Run a benchmark command and capture its output. |
| `log_experiment` | Record the result and keep or revert the change. |

## Dashboard

Results appear above the editor. Press Ctrl+Shift+F for a fullscreen table.
Navigate with arrow keys, j/k, PageUp/PageDown, or g/G; close with Escape or q.

After three measurements, a confidence score compares the best improvement with
observed noise. It is advisory; repeat noisy benchmarks before accepting results.

Override the shortcut in `<agent-dir>/extensions/pi-autoresearch.json`, where
`<agent-dir>` defaults to `~/.pi/agent` or `PI_CODING_AGENT_DIR`:

```json
{"shortcuts": {"fullscreenDashboard": "ctrl+shift+y"}}
```

Use `null` instead of a keybinding to disable it.

## Session files

State lives under `.auto/` in the session directory.

| File | Use |
| --- | --- |
| `prompt.md` | Objective, scope, and notes for resuming. |
| `measure.sh` | Benchmark emitting `METRIC name=number` lines. |
| `log.jsonl` | Experiment results. |
| `checks.sh` | Optional correctness checks after successful benchmarks. A failure blocks keeping the change. |
| `config.json` | Optional working directory and experiment limit. |
| `hooks/` | Optional iteration scripts. |

Example `config.json`:

```json
{"maxIterations": 30, "workingDir": "/path/to/project"}
```

`workingDir` changes where benchmarks, file operations, and Git commands run.
Relative paths resolve against the session directory. `maxIterations` caps the
experiment count; provider budgets must be configured separately.

## Hooks (optional)

- `.auto/hooks/before.sh` runs before each iteration.
- `.auto/hooks/after.sh` runs after each logged experiment.
- Mark scripts executable. They receive JSON on stdin.
- Stdout becomes an agent instruction, capped at 8 KB.
- Nonzero exits and timeouts over 30 seconds report an error to the agent.

Use the [hook skill](skills/autoresearch-hooks/SKILL.md) for input schemas and
[examples](skills/autoresearch-hooks/examples/README.md) for ready-to-adapt scripts.

## Attribution

Adapted from [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch).
See [VENDORED.md](VENDORED.md) for provenance and [LICENSE](LICENSE) for the MIT license.
