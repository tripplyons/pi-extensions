# Mixture

`mixture` fans one task out to 3 different models in parallel and hands every
labeled output back to the main pi thread. The main thread picks the best
answer or combines the best parts. It is the proposer half of a
mixture-of-agents setup; the calling session is the aggregator.

Each worker runs `pi --mode json` with its own `--model` inside its own linked
Git worktree under the macOS `sandbox-exec` profile reused from `agent-swarm`.
Worker launch outside macOS is refused, same as `agent-swarm`.

## Use

```js
const result = await tools.mixture_run({ task: "Implement retries for the webhook client with tests" });
text(result);
```

Or interactively: `/mixture Implement retries for the webhook client with tests`

The command posts the same labeled result as a steering message, so the next
turn synthesizes the final answer. Read each labeled output, take what is best,
and apply edits in the main checkout yourself. Worker branches stay around as
`pi-mixture/<run>/<slot>` for inspection.

## Config

`mixture_run` reads `${PI_CODING_AGENT_DIR:-~/.pi/agent}/mixture.json`. A missing
file (or one without `models`) gets the defaults written back automatically:

```json
{
  "models": [
    "openrouter/z-ai/glm-5.3-flash",
    "openrouter/deepseek/deepseek-v4.1-flash",
    "openrouter/meta/muse-spark-1.3-contributor"
  ],
  "timeoutMs": 600000
}
```

`models` is the full worker roster. `timeoutMs` bounds each worker call and can
be overridden per call. Malformed config fails with the path and reason.

## Notes

- Worker file edits land in per-model worktrees, never the coordinator checkout.
  Clean worktrees are removed after the run; worktrees with changes are kept
  alongside their branches for inspection.
- Auth: stored per-provider credentials are copied into each worker's private
  agent dir when present. Otherwise key-like environment values
  (`*_API_KEY`, `*_API_TOKEN`, `*_TOKEN`, e.g. `OPENROUTER_API_KEY`) pass
  through, same as a direct subagent child.
- macOS only. Worker launch elsewhere is refused, same as `agent-swarm`.
- All workers share one thinking level, inherited from the calling session.
  The 3 defaults all support `high`; `low` and `medium` do not resolve on
  every default model, so keep the session at `high` for mixture runs.
- 3 parallel calls cost roughly 3x one call. The result reports per-model usage.
- A worker that times out or fails does not block the others; the result carries
  whichever outputs succeeded plus each error.
