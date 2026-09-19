# MiniMax mode

Run `/minimax` to toggle, or `/minimax on|off`. Reload Pi after installing this
extension. Mode and todos follow the current session branch.

This is a Pi adaptation of MiniMax's public context policy, not its runtime or
model. It does not change models or create goals. Automatic resumption is limited
to interrupted compaction and background-task completion.

## Tools

While enabled, the local tools are `read`, `edit`, `write`, `bash`, `grep`, and
`glob`, using Pi's file implementations, ripgrep search, and a managed Bash wrapper. `read` uses
1-based line offsets in this mode, not the normal byte ranges. `bash` uses a terminating timeout, not
the normal shell's persistent tmux jobs. Existing jobs are not killed.

Previews use this repo's tool styles. Bash shows the same `$` command preview as
`shell`, including collapsed first/last lines and expansion. File calls show paths
and search patterns beside accent-colored tool names. Results show plain text,
including edit diffs, with eight-line previews and full output on expansion.
Native file-tool metadata does not replace the visible output.

`todo_write` replaces a persistent task list. `archive_read` retrieves bounded
Unicode character ranges of saved tool-result JSON. It remains available after
disabling the mode so checkpoint references can still be resolved.

Goal, autoresearch, and swarm tools keep their existing activation rules. Other
tools, including `shell`, `bg_process`, and `sleep`, are hidden and blocked.
The existing `ask_user` stays available if it was already active; this extension
does not register or activate another question tool. Disabling restores the displaced tools.

## Search pages

Search requires `rg` on `PATH`.

- `grep` supports `mode: "content"` (default), `"files"` (filenames only), and
  `"count"` (matching lines per file, not regex occurrences).
- `offset` is a zero-based result offset. Follow `next_offset` until it is `null`.
  Keep the same arguments between pages. Each page reruns the search, so file
  changes can shift results.
- Defaults: 100 records for `grep`, 1000 for `glob`. Pages cap at 1000 records
  and 48 KiB. Content and context lines each count as one record; long content
  lines are clipped to 500 characters. Use `read` for the full line.
- Results sort by path. `glob` also accepts `sort: "modified"` for newest first.
- Hidden and ignored files are excluded by default. `includeIgnored: true`
  requires an explicit `path`; use a narrow directory rather than the repo root.
- Searches stop after 30 seconds. Oversized records fail with a request to
  narrow the search. Paths are JSON-quoted to preserve unusual filenames.

For example, `grep({pattern: "createClient", mode: "files", limit: 20})` finds
candidate files without returning matching source lines.

## Reminders

After three assistant iterations repeat the same tool failure or poll a task
without advancing its output, the next request includes a strategy/wait
reminder. Further reminders follow every three matching iterations. New user
turns, changed errors, successful calls, or advancing output break the streak.
Parallel duplicates within one iteration do not count as separate iterations.
Loop streaks reset when their messages leave context during compaction.

Unfinished todos receive a review reminder after 15 assistant iterations without
a todo write or reminder. The cadence follows active-branch session history,
including across reloads and compaction. Completed or cancelled lists do not
receive reminders.

Reminders are mode-scoped and added only to an already scheduled model request,
when its estimated budget allows. They do not send messages that trigger another
turn, create goals, mark work complete, or declare a task blocked.

## Archiving

New tool results exceeding 64 KiB of UTF-8 text are immediately saved as
artifacts and replaced with retrieval receipts. This applies even to the newest
round and to errors; error status and image blocks remain intact. Control tools
and `archive_read` are exempt. The artifact is written and verified before
replacement. If saving fails, the original output stays visible with a warning.
The session stores the receipt; the artifact holds the original result.

Before model requests, a separate cumulative archiver follows MiniMax's public
default selection policy:

- Tool-result text must exceed 256 KiB in total.
- Estimated savings must exceed 256 KiB, subtracting 512 bytes per receipt.
- Individual candidates must contain at least 2 KiB of UTF-8 text.
- Protect the five latest settled tool rounds and every incomplete round.
- Exclude errors, control tools (skills, questions, todos, goals, planning), and
  archive retrieval. Leave malformed tool histories alone.

Cumulative archiving changes only the model-input projection; calls and existing
session results remain intact. Content-addressed artifacts live under
`~/.local/state/pi-rework/minimax/artifacts` (or `PI_REWORK_STATE_DIR`). References
are scoped to the active session branch. Missing artifacts leave existing
session results visible; recovering immediately capped text requires its artifact. There is no automatic artifact deletion.

Policy reference: [MiniMax's archiver](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/tool-result-archiver.ts).
This implementation is independent, not copied upstream code. It matches the
selection defaults, not MiniMax's remote configuration overrides or its
provider-specific tokenizer. After byte-based selection, new receipts are admitted
only if both the estimated token count and serialized LLM-message bytes decrease.
Original session details are excluded from this measurement.

Reminder admission includes the system prompt, active tool schemas, estimated
message tokens, an output reserve, and a 10% margin against the selected model's
context window. Unknown model limits suppress reminders.

Pi exposes a final `before_provider_request` payload hook, but no public dry-run
provider serializer/token-count API for comparing candidate contexts. These are
model-limit-aware estimates, **not exact provider request measurements**. No
extra API requests are made. Pi still handles provider limits and overflow
recovery. Rejected archive candidates may leave unreferenced artifacts; there
is no automatic artifact deletion.

## Compaction

`/threshold` controls automatic compaction (default 60k input tokens), checked
before model requests and when an agent run settles. A tool loop that crosses
the threshold first tries archiving. If receipts are present and the full projected
history, system prompt, and active tools fit below both `/threshold` and the
estimated model budget, it skips the checkpoint request. This uses the same
output reserve and safety margin as reminder admission, not exact provider counts.
If archiving is insufficient, the loop stops at the next request boundary,
compacts while idle, and resumes the interrupted request. Completed requests do not receive a continuation.
`/compact` and provider-overflow recovery still generate checkpoints rather than
taking the archive-only shortcut. MiniMax mode takes precedence over the normal pruner and Codex compactor, without
changing their saved settings.

The selected model generates a structured checkpoint covering goals,
constraints, completed work and evidence, current state, decisions, blockers,
pending requests and exact references. The host appends the stored
todo list separately. Todos are assistant-maintained, not proof of completion.
Failed, empty, truncated, or aborted summaries cancel compaction rather than
replacing history. Summarization uses the current provider and incurs its normal
usage cost.

## Background Bash

- Foreground timeout: 120 seconds by default, capped at 300. Omitted or
  non-positive values use the default.
- After 15 seconds, foreground Bash returns a task ID for the same process.
  Promotion does not restart it or extend its original deadline.
- `run_in_background: true` returns immediately. Its default timeout is 1800
  seconds; positive values are capped at 2147483.647 seconds.
- `task_query` lists this branch's tasks or retrieves one by `task_id`. `status`
  filters lists. Terminal statuses are `succeeded`, `failed`, `canceled`, `lost`.
- `task_output` returns up to 50 KiB. Offsets and `next_offset` count bytes.
  Omit offsets consistently to use this session's runtime cursor; explicit offsets leave
  that cursor unchanged. `wait_ms` defaults to zero and is capped at 30000.
- `task_stop` kills the process tree. A timeout also kills the process tree.
  Aborting a foreground call cancels it; promoted and explicit background tasks
  survive the launching turn.

Completion sends one notification and resumes the owning branch when Pi is idle
and MiniMax mode is enabled. Switching branches or disabling mode defers that
notification. Runtime shutdown stops managed tasks. Task metadata and full output
are stored outside the repo under `minimax/tasks` in the same state root as
archives. Output survives reload; unfinished records from a previous runtime
become `lost`, not reattached. Output cursors and pending notifications are
runtime-local. There is no automatic task-file deletion.

## Upstream prompts

The extension appends relevant harness instructions without replacing your
system prompt. The checkpoint prompt uses MiniMax's eight-section protocol and
separates conversation data from the final host control message. User-supplied
compaction instructions are escaped and labeled as untrusted data.

Adapted from [MiniMax Code](https://github.com/MiniMax-AI/minimax-code/tree/30dd6f27f1b03c06749774d3d8c6477fb2b9675a),
revision `30dd6f27f1b03c06749774d3d8c6477fb2b9675a`:

- `packages/local-runtime-v2/assets/agents/desktop-task/checkpoint/system.md`
- `packages/local-runtime-v2/src/service/turn-system/compaction/execution/checkpoint-prompt.ts`
- `packages/local-runtime-v2/assets/agents/_default/prompt-base-all.md`
- Background-tool instructions and schemas from `packages/agent-tools/src/desktop/builtin-defs.ts`.

Pi adaptations preserve `/threshold`, existing tool activation rules, and archive
IDs. Stored todos are not described as verified facts. Unrelated upstream agent
identity, permission, and completion policies are not imported. See
[LICENSE.minimax](LICENSE.minimax) for the retained MIT notice.
