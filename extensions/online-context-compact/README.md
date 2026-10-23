# Online Context Compact

Adds `update_plan` and requests [Context Folding](../context-folding) at
finished plan steps. It does not call Pi's native compaction, abort the run,
or start a continuation turn. Load Context Folding alongside this extension
so the agent has `context_status` and `compress`.

The agent sends the complete plan on each call. Each step has an `id`, a
`goal`, and a status of `pending`, `in_progress`, or `completed`. When a step
is completed, the call can include `progress` with changed files, verification,
and decisions. The plan is stored in the session and survives reloads.

## Folding triggers

When a previously unfinished step becomes completed, the extension estimates
older context outside an 8,000-token recent tail. It uses the provider's last
projected messages, including earlier folds, rather than the original text.
The retention cut is an estimate, not the range the agent must fold.

A hidden message asks the agent to inspect `context_status` and summarize
finished work with `compress`. The agent chooses safe ranges and leaves
material needed for editing or verification verbatim. The request preserves
other extensions' turn-boundary entries and does not interrupt the task.
Managed plan updates suppress Context Folding's own boundary reminder.

The trigger favors folding: at least 4,000 tokens of older context can request
a fold even on the last step, provided earlier cache rewrite debt is paid.
Otherwise, it uses the cost model adapted from SoL-Pi: estimated later requests
must repay the cache rewrite cost, priced at 12.5 times a cached read. Near the
context window limit, window protection overrides the economic test when
folding is estimated to save tokens. Requests are advice, not guaranteed folds.
A repeated plan-only update does not repeat the request until real tool work
or user input occurs.

## Rewrite accounting

A committed fold or restore emits `pi:context-fold`. This extension charges
its actual rewrite cost, credits saved tokens toward repayment on subsequent
requests, and resets the context-growth baseline. Sending a folding request
alone creates no debt. External native compaction resets this baseline and
the folding debt; this extension never requests it.

A steering message or a message starting with `CORRECTION:` clears the plan
and its request history. A new prompt after a finished plan does the same.
Pi's built-in automatic compaction remains a separate safety net. This
extension does not change its settings.

This extension replaces the todos extension and its `todo_write` tool.

Adapted from [SoL-Pi](https://github.com/NVlabs/SoL-Pi) Online Context Compact.
See `licenses/sol-pi.txt` for the MIT license.
