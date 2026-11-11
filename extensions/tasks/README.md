# Background tasks

Adds managed background execution to Pi's native Bash implementation. If a
command is still running after 5 seconds, Bash returns a task ID for the same
process. User steering or a delivered swarm message returns it sooner. The
process, its output, and its deadline do not change. Queued follow-up messages
do not affect the 5-second wait.

Every command has a 1800-second (30-minute) default deadline, whether it
finishes in the foreground, is promoted, or starts in the background. Set
`timeout` in seconds for a different deadline, for example:

```text
bash command="npm run build" timeout=3600
```

`run_in_background: true` returns the task ID immediately. Wait for a task
with `sleep`, and query, read, or stop it with `task_query`, `task_output`, and
`task_stop`. Expiry and stop terminate the process group. Nonzero exits fail the
task, including Pi 1.0's non-throwing Bash results. Failed foreground commands
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
separate follow-up turn. If the session's automatic cursor already reached the
end of the output when the task finishes, the notice does not start a turn. It
joins the next turn instead. Each notice gives the exit code, and a zero-exit
pipeline without `pipefail` carries a hint that earlier commands may have
failed. Observing terminal status acknowledges the notification without
consuming unread output. Explicit byte offsets do not
advance the automatic output cursor. Each output read returns at most 2,000 lines
or 50 KB and keeps UTF-8 characters intact. `next_offset` counts bytes actually
returned, so the next read preserves unread output. Use `next_offset` for explicit
reads instead of guessing a byte offset within a character.

`task_output` reads without waiting. A read of a live task with no new output
returns empty output and an unchanged `next_offset`.

## Wait with sleep

`sleep` is the only wait. It takes `seconds`, from 1 to 1800, and returns early
on the first of these events:

- user steering input, reported as `steering`
- a swarm inbox message, health alert, worker check-in, or review reminder,
  reported as `swarm`
- the end of any background task on the current branch, reported as `task`
- the exit of the last process a Bash command left running, for example with
  `nohup job > log &`, reported as `process`

For example:

```text
sleep seconds=600
```

The result gives the wake reason, the time slept, and a completion notice for
each finished task. Sleep counts those notices as delivered, so they do not
also start a separate turn. Read the output with `task_output` before you claim
success. If a completion is already waiting when `sleep` starts, it returns at
once.

Each notice also gives `unread_bytes`, the output this session has not read
yet. Do not call `task_output` in the same batch as `sleep`. Batched calls run
at the same time, so the read can happen just before the task finishes and
report `running`. If a later `sleep` starts while a reported task still has
unread output, it returns at once with the reason `unread` and lists those
tasks. It reminds only once per task, so the next sleep waits as asked.

Each Bash shell leads its own process group, and the runner records its PID.
If processes started with `&` or `nohup` are still in that group when the shell
exits, the Bash result or completion notice says so, and the group is watched
once a second. When it empties, a sleeping conversation wakes with
`processes_exited`, which names the command; one that exited before the sleep
makes the sleep return at once. Each exit is reported once. A process that
leaves the group, for example with `setsid`, is not tracked, and neither are
processes on another machine: a local `modal run` client is tracked, a detached
remote app is not. This catches a remote job that fails within seconds while
the agent sleeps for many minutes.

If no event arrives before `seconds` elapses, the result reports `timeout` and
a progress snapshot for each running task on the branch. Tracked groups that are
still running appear in `detached`. A snapshot holds the
elapsed time, captured output bytes, seconds since the last output, remaining
deadline, and up to five recent output lines. It does not move the output
cursor. Output silence does not prove that a process is stuck. To follow a log
file that the command writes, read it with Bash, for example with `tail`.

Sleep never stops a task or extends its deadline. Canceling a sleep leaves
tasks running, and their completion notices arrive as usual. Follow-up messages
do not wake a sleep. If the agent ends its turn instead of sleeping, an
unobserved completion still starts a new turn.

When run through T3 Code's Pi provider, live background tasks keep the thread
marked as running after Pi's foreground turn ends. This includes explicit
background Bash and auto-promoted commands. Completion or stop
clears the task without waiting for its notification to reach an idle agent.
Update both T3 Code and these extensions, then restart the Pi provider session
to load the reporting bridge.

## Interactive input

Commands read an empty stdin by default. Pass `stdin: true` to `bash` to connect
stdin to a pipe instead, then send text with `task_input`:

```text
bash command="stockfish" stdin=true run_in_background=true
task_input task_id=<id> text="position startpos moves e2e4\ngo depth 12\n" wait_seconds=3
task_input task_id=<id> text="quit\n" eof=true
```

`task_input` writes the text, then waits up to `wait_seconds` (0 to 60, default
2) or until the task ends. It returns the bytes written, whether stdin is
closed, and new output from the automatic `task_output` cursor. `eof: true`
closes stdin after the write, so a program that reads to end of input can
finish. A task started without `stdin: true` rejects input. If the process does
not read and the pipe fills, the call reports how many bytes it wrote.

The pipe is a named FIFO in the task directory. The runner holds it open, so
the shell never blocks when it opens stdin, and the reader sees end of input
only after `eof`. stdin is not a terminal. A program that buffers its output
when not on a terminal may need an unbuffered flag, such as `python -u`, or a
pseudo-terminal wrapper, such as `script`.

## Long jobs

The `bash` description tells the model to estimate a long job's run time and
try a small case first, and to run servers and interactive programs in the
background. The `sleep` description tells it to read `task_output` between
sleeps and stop a job that is not progressing at the estimated rate, instead
of waiting for the deadline. In the FrontierHarness Eval live run (November
2026), most of stock Pi's pass-rate gap to Codex CLI came from agent timeouts
on long or interactive tasks.

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

## Reload and storage

Session replacement and /reload keep the process pool and rebind notifications.
Reload also updates the runner methods without restarting managed tasks or
resetting output cursors. Quit stops the pool. Abandoned records from a prior process become lost.
The removed `task_watch` tool left `pi:task-watch` entries in older sessions.
They stay in the session files, and this extension ignores them.

Task metadata and output stay under the agent directory, outside this repo.
The existing `minimax/tasks` storage path remains so old task records are readable.

The task runner and command preview derive from MiniMax Code. The bundled
`LICENSE.minimax` retains its MIT license and attribution.
