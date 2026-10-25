# Action Fusion

Adds an optional `then_run` argument to Pi's native `edit` and `write` tools.
The command runs after the change lands, in the same tool call, so the agent
does not spend a separate turn on the build, test, or restart that usually
follows an edit.

```json
{ "path": "src/a.ts", "edits": [...], "then_run": { "command": "npm test", "timeout": 120 } }
```

- The edit or write runs first through Pi's own tool definition. If it fails,
  the command is skipped and the error says `[then_run:skipped]`.
- The file stays locked until the command finishes or returns a background
  task ID. Other fused calls on the same file, including through symlinks,
  wait their turn. A background command does not keep the file locked.
- If the file changes between the write and the command, the command is
  skipped.
- The command output follows the edit result after `[then_run:succeeded]` or
  `[then_run:failed]`. A non-zero exit or timeout marks the call as an error
  but keeps the change.

Commands require the managed Bash tool from the [tasks](../tasks) extension.
If it is unavailable, the call fails before changing the file. Both `edit` and
`write` use the same managed execution path, including job ownership records,
completion notifications, and steering support.

Commands return a task ID after 15 seconds rather than blocking the worker.
These results use `[then_run:running]`, not a success marker. Follow the task
with `task_output`, `task_query`, or `task_stop`; do not rerun it. Swarm health
includes these commands in the worker's owned jobs. The default deadline is
120 seconds, with a maximum of 300 seconds. Promotion does not extend it.

The [evidence-preserving reducer](../evidence-preserving-reducer) can shorten a
long command log in a fused result.

Adapted from [SoL-Pi](https://github.com/NVlabs/SoL-Pi) Action Fusion. See
`licenses/sol-pi.txt` for the MIT license.
