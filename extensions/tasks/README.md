# Background tasks

Adds managed background execution to Pi's native Bash implementation. Foreground
commands default to 120 seconds and allow up to 300 seconds. After 15 seconds,
a foreground command returns a task ID without restarting its process or deadline.

`run_in_background: true` starts a managed task immediately with a default
30-minute deadline. Query, read, or stop it with `task_query`, `task_output`, and
`task_stop`. Expiry and stop terminate the process group. Nonzero exits fail the
task, including Pi 1.0's non-throwing Bash results. The [Python tool](../python)
uses this same runner for inline uv scripts and returns task IDs immediately.
Failed foreground commands
return the native stdout/stderr, exit status, truncation metadata, and full-output
path when present. Task failure tracking does not replace those diagnostics with
an exit-code-only error.

Normal foreground previews keep Pi's native output tail. If Pi reports truncated
output but returns an empty preview, the runner recovers a leading preview from
its captured output, bounded to 2,000 lines or 50 KB with intact UTF-8 characters.
The notice identifies the leading preview and any partial final line. The native
full-output path, structured result, and exit diagnostics remain available;
recovery does not consume the task's automatic output cursor.

Tasks belong to their launching session branch. Completion notifications wait
for idle and arrive in one steering message per batch. They never queue a
separate follow-up turn. Observing terminal status acknowledges the
notification without consuming unread output. Explicit byte offsets do not
advance the automatic output cursor. Each output read returns at most 2,000 lines
or 50 KB and keeps UTF-8 characters intact. `next_offset` counts bytes actually
returned, so the next read preserves unread output. Use `next_offset` for explicit
reads instead of guessing a byte offset within a character.

`task_output` accepts `wait_ms` (default 0, capped at 30,000 ms). It waits only
when a live task has no unread bytes at the requested or automatic cursor.
Unread output and terminal status return immediately. A silent live task can
return empty output and an unchanged `next_offset` after the wait expires;
that does not mean it skipped the wait. New output or completion wakes the read
early. `wait_ms` is not a minimum polling interval and does not stop the task.

## Opt-in pipeline failure detection

Pass `pipefail: true` to `bash` when a pipeline must expose an upstream failure:

```text
bash command="modal run test.py | tee run.log" pipefail=true
```

This enables `set -o pipefail`. A pipeline returns the rightmost nonzero exit
status, or zero if every command succeeds. It applies to foreground, background,
and auto-promoted tasks. It is off by default, does not enable `set -e`, and does
not report each command's status. Later commands can still replace a pipeline's
exit status. The command can explicitly change shell options.

## Local and remote cleanup

`task_stop`, deadline expiry, and runtime shutdown stop the local process tree.
They do not guarantee that detached cloud apps, containers, or remote function
calls stop. A completed local command does not prove that remote work completed.

For remote work, record the provider, app and function-call IDs, authorized scope,
remote timeout, result path, status and cleanup commands, and cleanup evidence in
task notes outside this repo. Verify remote cleanup with the provider's status
command. Stop only resources started for the authorized task. Do not stop
production resources or other users' resources.

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

### Watch a local log file

Add `log_path` when the command redirects output to a local file:

```text
task_watch task_id=<id> log_path=run.log interval_seconds=300 silence_seconds=120
```

Relative paths resolve against the task's original working directory, not the
current session directory. The resolved path persists with the watch settings.
Each report reopens the path, so truncation and log rotation do not leave the
watch attached to an old file.

Reports show the log's current size, modification time, time since modification,
and up to 2 KB and five recent lines. Log data is separate from captured Bash
output and does not change output cursors. Missing, unreadable, or nonregular
files appear as unavailable in the report. The watch continues and retries on
the next report.

`silence_seconds` applies independently to captured output silence and the
log's time since modification. Reports distinguish "captured output is silent"
from "watched log is unchanged." Neither proves that the process is stuck.
Modification time is a file signal, not proof of useful work.

Watching reads local files into model context and session history. Select only
logs suitable for that context. It does not fetch remote logs or watch files
after the local task finishes.

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
