# Mixture

`mixture` starts one background worker per configured model. The root session
can inspect, steer, stop and restart workers while doing other work. Completed
attempts send their labeled output and usage back to the root.

Each worker runs `pi --mode rpc` with its own `--model` inside its own linked
Git worktree under the macOS `sandbox-exec` profile reused from `agent-swarm`.
Worker launch outside macOS is refused, same as `agent-swarm`.

Workers use native Pi file tools and bg-bash with Codex tool overrides disabled. Each has a private tmux socket and caches under its temporary directory. Completion events wake pending bg-bash sleep calls while mixture is enabled.

## Use

Mixture is disabled on startup, reload, and session changes. Run `/mixture`
to enable its tools and completion notifications for the current session.
Run it again to disable them. The command does not accept a task or launch workers.

After enabling, ask the agent to run a task, or call its native tools:

```js
mixture_run({ task: "Implement retries for the webhook client with tests" });
// The response contains a run ID, such as mix_abc123.
mixture_process({ action: "inspect", runId: "mix_abc123" });
mixture_process({ action: "send", runId: "mix_abc123", workerId: "slot-0", message: "Include a test for HTTP 429" });
```

`mixture_run` returns after launching the supervisor, without waiting for
model output. Completion messages wake the root for synthesis. Review each
worktree and apply selected edits yourself. Mixture never merges or commits
worker changes into the root checkout.

## Manage runs

TUI tool cards show the action, run ID and worker statuses instead of raw JSON.
Expand results for longer output excerpts, usage and the full-state file path.
Completion cards use the same layout. Model-facing results remain structured JSON.

- `list` lists runs owned by this session.
- `inspect` takes `runId` and optionally `workerId`. It returns attempt history,
  outputs, errors, usage, command acknowledgements and retained paths.
- `send` requires `runId`, `workerId` and a nonempty `message`. It steers a
  running worker. A worker already settling its final result rejects steering.
- `stop` takes `runId`. Add `workerId` to stop only that worker.
- `restart` requires `runId` and `workerId`. It starts a fresh model session in
  the same retained worktree. Earlier output, logs and usage remain available.
- `resume` takes `runId` and explicitly transfers control to the current root
  session. The previous session can still inspect it, but cannot change it
  without another explicit transfer.

Control calls return a queued request ID. Inspect the run for its accepted or
rejected acknowledgement. Do not repeat a queued request. Inspection responses
are bounded; the response points to the full `run.json` when truncated.

Disabling mixture does not stop existing workers. Re-enable it to manage them
and receive pending completion notifications. Stop workers with `mixture_process`
before disabling if you want them to stop.

The detached supervisor survives root shutdown. Reopening the same Pi session
and enabling mixture restores completion notifications. A different session must explicitly resume
the run. Worker timeouts continue while the root is disconnected.

Reconnecting also wakes unfinished runs whose supervisor is no longer alive.
An interrupted attempt becomes failed, with its last recorded output and usage
preserved. Unacknowledged steering is marked delivery-unknown, never replayed
automatically. Inspect its worker session before resending it. Restart refuses
to run while the previous recorded worker PID still exists. A supervisor crash
does not preserve its RPC pipes or timeout timer; inspect and stop orphaned
processes before restarting. Root shutdown alone does not cause this condition.

Preparation failures retain an error log but have an empty session path because
Pi never started. Runtime startup diagnostics are in `supervisor.log` and each
attempt's RPC stderr log.

State lives under `${PI_MIXTURE_HOME:-${XDG_STATE_HOME:-~/.local/state}/pi/mixture}`,
outside this repository. Each run retains `run.json`, its command mailbox,
supervisor log, worktrees and per-attempt RPC logs and session files. State can
contain task text, outputs and credentials in private worker agent directories.
Do not publish it.

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

- A Git repository with a commit is required. Workers start from `HEAD`, not
  the root checkout's uncommitted edits.
- All worktrees and `pi-mixture/<run>/<slot>` branches are retained, including
  clean ones. Uncommitted and untracked files belong to the worktree, not the
  branch. Inspection reports `git status --short` after each attempt.
- Stop workers before manual cleanup. Remove their worktrees with `git worktree
  remove`, delete their branches if unwanted, then remove the run directory.
- Auth: stored per-provider credentials are copied into each worker's private
  agent dir when present. Otherwise key-like environment values
  (`*_API_KEY`, `*_API_TOKEN`, `*_TOKEN`, e.g. `OPENROUTER_API_KEY`) pass
  through, same as a direct subagent child.
- macOS only. Worker launch elsewhere is refused, same as `agent-swarm`.
- All workers share one thinking level, inherited from the calling session.
  The 3 defaults all support `high`; `low` and `medium` do not resolve on
  every default model, so keep the session at `high` for mixture runs.
- 3 parallel calls cost roughly 3x one call. The result reports per-model usage.
- A worker that times out or fails does not block the others. Its partial
  output and recorded usage remain available alongside the error.

## Verification

```sh
bun test extensions/mixture
PI_MIXTURE_E2E=1 bun test extensions/mixture/e2e.test.ts extensions/mixture/reconnect.test.ts
npm test
git diff --check
```

The opt-in tests make paid model calls. They verify steering, process stop,
ownership transfer, restart, usage and retained files, then launch a real Pi
root to verify completion delivery and session reconnect. They print retained
artifact paths for inspection.
