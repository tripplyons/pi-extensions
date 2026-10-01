# Background tasks

Adds managed background execution to Pi's native Bash implementation. Foreground
commands default to 120 seconds and allow up to 300 seconds. After 15 seconds,
a foreground command returns a task ID without restarting its process or deadline.

`run_in_background: true` starts a managed task immediately with a default
30-minute deadline. Query, read, or stop it with `task_query`, `task_output`, and
`task_stop`. Expiry and stop terminate the process group. Nonzero exits fail the
task, including Pi 1.0's non-throwing Bash results.

Tasks belong to their launching session branch. Completion notifications wait
for idle and arrive in one batch. Observing terminal status acknowledges the
notification without consuming unread output. Explicit byte offsets do not
advance the automatic output cursor. Session replacement and /reload keep the process pool and rebind notifications.
Quit stops the pool. Abandoned records from a prior process become lost.

Task metadata and output stay under the agent directory, outside this repo.
The existing `minimax/tasks` storage path remains so old task records are readable.

The task runner and command preview derive from MiniMax Code. The bundled
`LICENSE.minimax` retains its MIT license and attribution.
