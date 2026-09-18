# MiniMax mode

Run `/minimax` to toggle, or `/minimax on|off`. Reload Pi after installing this
extension. Mode and todos follow the current session branch.

This is a Pi adaptation of MiniMax's public context policy, not its runtime or
model. It does not change models, create goals, or add automatic continuation.

## Tools

While enabled, the local tools are `read`, `edit`, `write`, `bash`, `grep`, and
`glob`, using Pi's native implementations. `read` uses 1-based line offsets in
this mode, not the normal byte ranges. `bash` uses a terminating timeout, not
the normal shell's persistent tmux jobs. Existing jobs are not killed.

`todo_write` replaces a persistent task list. `archive_read` retrieves bounded
Unicode character ranges of saved tool-result JSON. It remains available after
disabling the mode so checkpoint references can still be resolved.

Goal, autoresearch, and swarm tools keep their existing activation rules. Other
tools, including `shell`, `bg_process`, `sleep`, and `ask_user`, are hidden and
blocked. Disabling restores the displaced tools.

## Archiving

Before model requests, the archiver follows MiniMax's public default selection
policy:

- Tool-result text must exceed 256 KiB in total.
- Estimated savings must exceed 256 KiB, subtracting 512 bytes per receipt.
- Individual candidates must contain at least 2 KiB of UTF-8 text.
- Protect the five latest settled tool rounds and every incomplete round.
- Exclude errors, control tools (skills, questions, todos, goals, planning), and
  archive retrieval. Leave malformed tool histories alone.

Only the model-input projection changes; calls and original session results
remain intact. Content-addressed artifacts live under
`~/.local/state/pi-rework/minimax/artifacts` (or `PI_REWORK_STATE_DIR`). References
are scoped to the active session branch. Missing artifacts leave original
results visible. There is no automatic artifact deletion.

Policy reference: [MiniMax's archiver](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/tool-result-archiver.ts).
This implementation is independent, not copied upstream code. It matches the
selection defaults, not MiniMax's remote configuration overrides or its
provider-specific token/serialized-request admission layer. Pi handles provider
limits and overflow recovery; archive selection itself is byte-based.

## Compaction

`/threshold` controls automatic compaction (default 100k input tokens), checked
when an agent run settles. `/compact` and overflow recovery also work. MiniMax
mode takes precedence over the normal pruner and Codex compactor, without
changing their saved settings.

The selected model generates a structured checkpoint covering goals,
constraints, completed work and evidence, current state, decisions, blockers,
pending requests, next steps, and exact references. The host appends the stored
todo list separately. Todos are assistant-maintained, not proof of completion.
Failed, empty, truncated, or aborted summaries cancel compaction rather than
replacing history. Summarization uses the current provider and incurs its normal
usage cost.
