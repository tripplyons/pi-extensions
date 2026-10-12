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
- The file stays locked from the change until the command finishes. Other
  fused calls on the same file, including through symlinks, wait their turn.
- If the file changes between the write and the command, the command is
  skipped.
- The command output follows the edit result after `[then_run:succeeded]` or
  `[then_run:failed]`. A non-zero exit or timeout marks the call as an error
  but keeps the change.

Commands run through Pi's native Bash tool, not the background-task Bash from
the [tasks](../tasks) extension. `timeout` is in seconds and has no default.

The [evidence-preserving reducer](../evidence-preserving-reducer) can shorten a
long command log in a fused result.

Adapted from [SoL-Pi](https://github.com/NVlabs/SoL-Pi) Action Fusion. See
`licenses/sol-pi.txt` for the MIT license.
