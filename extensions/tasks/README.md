# Background tasks

Adds managed background execution to Pi's native Bash implementation. Foreground
commands default to 120 seconds and allow up to 300 seconds. After 15 seconds,
a foreground command returns a task ID without restarting its process or deadline.

`run_in_background: true` starts a managed task immediately with a default
30-minute deadline. Query, read, or stop it with `task_query`, `task_output`, and
`task_stop`. Expiry and stop terminate the process group. Nonzero exits fail the
task, including Pi 1.0's non-throwing Bash results. Failed foreground commands
return the native stdout/stderr, exit status, truncation metadata, and full-output
path when present. Task failure tracking does not replace those diagnostics with
an exit-code-only error.

Tasks belong to their launching session branch. Completion notifications wait
for idle and arrive in one steering message per batch. They never queue a
separate follow-up turn. Observing terminal status acknowledges the
notification without consuming unread output. Explicit byte offsets do not
advance the automatic output cursor. Each output read returns at most 2,000 lines
or 50 KB and keeps UTF-8 characters intact. `next_offset` counts bytes actually
returned, so the next read preserves unread output. Use `next_offset` for explicit
reads instead of guessing a byte offset within a character.

## Opt-in progress reports

Use `task_watch` for a long task on the current branch:

```text
task_watch task_id=<id> interval_seconds=300 expected_seconds=900 silence_seconds=120
```

Reports show elapsed time, output bytes, bounded recent output, output silence,
and remaining deadline. They do not move the output cursor or extend the deadline.
For a finished task, elapsed time and output silence stop at `finished_at`, and
the remaining deadline is null.
`expected_seconds` is a user-supplied duration, not a measured ETA. Reports wait
until Pi is idle. Every scheduled report wakes the conversation to check the task
and give an evidence-based progress update. Expected-duration and output-silence
warnings ask the agent to investigate, including when a warning persists across
reports. Warning thresholds are optional; the default report interval is 300
seconds and the maximum is 300.

Watching is off unless requested. Disable it with `enabled: false`. Watch settings
are branch-local session entries. Reload restores enabled watches for live tasks
on that branch. Watching stops when the task finishes or the session shuts down.
It never stops a process. The remaining deadline is unknown for legacy task
records that did not save one.

Session replacement and /reload keep the process pool and rebind notifications.
Reload also updates the runner methods without restarting managed tasks or
resetting output cursors. Quit stops the pool. Abandoned records from a prior process become lost.

Task metadata and output stay under the agent directory, outside this repo.
The existing `minimax/tasks` storage path remains so old task records are readable.

The task runner and command preview derive from MiniMax Code. The bundled
`LICENSE.minimax` retains its MIT license and attribution.
