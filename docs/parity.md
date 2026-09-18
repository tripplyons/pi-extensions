# Stack configuration parity

Source of truth: `../dotfiles/home/dot_config/stack-agent/{plugins,builtin}`,
installed `~/.config/stack-agent`, and the runtime in `../stack-based-harness`.
User requested all areas below, rebuilt from scratch. No legacy compatibility
layer. Work takes place only on `rework`; no push or changes to `main`.

A checked item requires behavior tests and package/runtime evidence, not merely
registration or documentation. This list tracks deliverables, not completion.

| Area | Required behavior | State |
| --- | --- | --- |
| Ask user | Suggestions, free text, timeout/cancel, worker restriction | Implemented; unit tested |
| Autocomplete | Commands, skills, files, editor integration | Native provider tested; interactive keyboard audit pending |
| Complaints | Private records, session/cwd/model/effort, harness-only policy | Implemented; unit tested |
| Pruner | Off default, 50 KB, keep five, skill/retrieval protection, reasoning, durable archive, /prune /pruner | Implemented; unit tested; reasoning persistence audit pending |
| Goals | Explicit creation, user controls, persistence, elapsed/tokens, automatic continuation, full-objective verification | Implemented; unit tested; runtime audit pending |
| Overseer | Terminal OSC glow, lifecycle and input waits | Implemented; state test; TTY audit pending |
| Presentation | Compact display, status/footer, identity/title, tool visibility | Implemented; formatting tests; TTY audit pending |
| Shell/background/sleep | tmux zsh PTY, bounded foreground wait, persistent jobs, input/EOF, scope ownership, cancellation, wakeups | Implemented; real tmux tests |
| Files/images | Bounded UTF-8 read, atomic write, exact unique edit, listing/search limits and skipped counts, images | Implemented; unit tested |
| Swarm | User activation, worker tree/depth, worktrees and dirty choices, durable tasks, messages, observe/restart/review/stop/cleanup | Git isolation, durable state, messaging permissions and review tested; orchestration pending |
| Compaction | Codex native compaction, checkpoints, restore, manual/automatic controls | Implemented; synthetic protocol/transport/hook tests; provider integration audit pending |
| Fast mode | Priority tier request setting and persisted toggle | Implemented; payload tests; runtime audit pending |
| Models/reasoning | List/select models, supported reasoning, persistence | Implemented via Pi registry/session APIs; command tests; persistence runtime audit pending |
| Usage/cost | Codex limits/reset information and API cost reporting | Pending |
| Sessions | New/resume/fork/tree/name/export, command discoverability | Native session file persistence/fork/state tests; UI/export audit pending |
| Skills | Shared and Stack-specific skills, read-before-use policy | Implemented; real Pi loader and prompt tests; TUI invocation audit pending |
| Retry/approval | Retry settings and cancellation; Stack approval policy equivalents | Pending |

Runtime differences must be stated explicitly and tested at the actual API seam.
Do not replace a required feature with a stub or count an untested native feature
as verified. Network checks must not expose credentials.

### Native completion boundary

`tests/autocomplete.test.ts` exercises Pi's actual CombinedAutocompleteProvider:
command and skill suggestions, relative file suggestions, accepting each result,
and cursor placement. The interactive runtime registers extension commands and
loaded skills with this provider. No replacement editor is installed. Keyboard
selection/dismissal and fuzzy `@` workspace lookup still need interactive checks;
Stack's ranking algorithm and two-row footer are not reproduced by this test.

Session commands and tested persistence guarantees are described in [sessions](sessions.md).

## Retry audit

Dotfiles now sets Pi's agent retry budget to three retries with a 2-second base
(2/4/8 seconds), matching `builtin/retry.lua`; migration tests cover idempotence
and rejection of malformed retry settings. Provider-level retries remain separate.
Pi's `isRetryableAssistantError` classifies error strings without checking partial
output, whereas Stack rejects partial output and structured auth/quota/protocol
errors. Exact retry eligibility and layered retry budgets remain open; matching
the schedule alone is not full parity. Stack's approval policy allows shell,
write, and edit by default, matching our direct tool execution for those tools.

Real CLI boundary: `tests/rpc.test.ts` starts the installed Pi CLI with every
manifest extension, an isolated HOME/state directory, and an allowlisted
environment without provider credentials. It verifies command registration,
user-command swarm activation, durable run creation, no extension errors, and no
agent/model turn. This does not yet verify an actual worker model turn.
