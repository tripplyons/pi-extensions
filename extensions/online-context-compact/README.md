# Online Context Compact

Adds `update_plan` and compacts context at step boundaries when doing so saves
cost.

The agent sends the complete plan on each call. Each step has an `id`, a
`goal`, and a status of `pending`, `in_progress`, or `completed`. When a step
is completed, the call can include `progress` with changed files, verification,
and decisions. The plan is stored in the session and survives reloads.

When a step that was previously unfinished becomes completed, the extension
compares two costs:

- Compaction rewrites the remaining prompt into the provider cache, at 12.5
  times the price of a cached read.
- Each later request then reads fewer tokens.

The number of later requests is estimated from the requests spent on earlier
steps and the steps left, and is capped by the remaining context window. If
the savings pay for the rewrite in time, the extension stops the run after the
plan update, runs Pi's native compaction, and starts a hidden turn to continue
the plan. Later compactions also need a 1.5 times margin, must repay earlier
rewrite costs, and wait at least two requests after the last compaction. Near
the context window limit, compaction runs regardless of cost.

A steering message or a message starting with `CORRECTION:` clears the plan
and its request history. A new prompt after a finished plan does the same.
If Pi refuses to compact, the task continues with the existing context.
Pressing Escape during compaction stops the task.

Before the planned stop, the extension emits `pi:online-compaction` on
`pi.events` with phase `aborting`. It emits `continuing` before the hidden turn
and `stopped` when Escape cancels compaction. The goal extension uses these
phases so a planned stop does not pause an active goal.

This extension replaces the todos extension and its `todo_write` tool.

Adapted from [SoL-Pi](https://github.com/NVlabs/SoL-Pi) Online Context Compact.
See `licenses/sol-pi.txt` for the MIT license.
