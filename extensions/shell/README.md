# Shell and background jobs

Requires `tmux` and `zsh` on PATH. Jobs use a dedicated `pi-rework` tmux server
and private directories under the rework state root. They survive Pi exits;
`bg_process` can recover them by session ID. No user tmux sessions are touched.

- `shell`: the command execution tool, replacing built-in `bash`; execute in a PTY; timeout is foreground grace, not a kill deadline.
- `bg_process`: list/output/write/kill/clear; foreign jobs require `scope=all`.
- `sleep`: bounded wait; wake on job exit, pending input, or swarm activity.

Cancellation during the foreground wait kills that job. Cancelling `sleep` does
not kill jobs. `write` sends literal PTY input; include a newline to submit a
line, or use `end=true` for terminal EOF. Output is bounded; complete output and
job metadata remain in the private job directory until cleared. A dead tmux
server is reported as a lost job, not a successful exit.

Tool results display as plain-text previews instead of JSON. Expand a result to
see all fields and output; structured result data is unchanged.

The extension removes `bash` from active tools on startup, session switches, and
before each agent turn. Use `shell` to start commands and `bg_process` to manage
running jobs.

Collapsed shell calls show the first three and last three command lines, with a
hidden-line count in the theme’s dim color between them. The tail follows streamed argument updates,
including the unfinished last line. Long lines are clipped rather than wrapped.
Expanded mode shows the full command with wrapping. Execution and stored arguments
are unchanged.

Sleep calls show the requested duration and a live remaining-time countdown while
waiting, refreshed about every 100 ms. The countdown clears on completion, early
wake, or cancellation.

The shell `$` prefix and other tool names use the theme accent color, matching
the footer folder name. Command text and sleep timing keep their normal color.
