# Online Context Compact

Adds `update_plan` and requests Pi's native compaction at finished plan steps.
Native compaction interrupts the active run. After requested compaction finishes,
the extension starts a hidden continuation turn to resume the task. New user input,
pending messages, or a session change suppress that continuation.

The agent sends the complete plan on each call. Each step has an `id`, a
`goal`, and a status of `pending`, `in_progress`, or `completed`. When a step
is completed, the call can include `progress` with changed files, verification,
and decisions. The plan is stored in the session and survives reloads.

## Compaction triggers

When a previously unfinished step becomes completed, the extension estimates
older context outside an 8,000-token recent tail using the provider's last
projected messages. This tail is a cost estimate; Pi controls native retention
and summary generation.

The cost model adapted from SoL-Pi requires estimated later requests to repay
the cache rewrite cost, priced at 12.5 times a cached read. Later compactions
also account for outstanding rewrite debt and a request cooldown. Near the
context window limit, window protection overrides the economic test when
compaction is estimated to save tokens. Completing the last step does not
force an uneconomic rewrite.

A successful requested compaction charges estimated rewrite debt and credits
estimated token savings toward repayment on later requests. Failed requests
do not charge debt. Native compaction resets the context-growth baseline;
external compaction also clears earlier debt.

A steering message or a message starting with `CORRECTION:` clears the plan
and its request history. A new prompt after a finished plan does the same.
Pi's built-in automatic compaction remains enabled. This extension does not
change its settings. No Context Folding extension or tools are required.

This extension replaces the todos extension and its `todo_write` tool.

Adapted from [SoL-Pi](https://github.com/NVlabs/SoL-Pi) Online Context Compact.
See `licenses/sol-pi.txt` for the MIT license.
