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
| Autocomplete | Commands, skills, files, editor integration | Pending |
| Complaints | Private records, session/cwd/model/effort, harness-only policy | Implemented; unit tested |
| Pruner | Off default, 50 KB, keep five, skill/retrieval protection, reasoning, durable archive, /prune /pruner | Implemented; unit tested; reasoning persistence audit pending |
| Goals | Explicit creation, user controls, persistence, elapsed/tokens, automatic continuation, full-objective verification | Implemented; unit tested; runtime audit pending |
| Overseer | Session file and terminal notification integration, lifecycle and input waits | Pending |
| Presentation | Compact display, status/footer, identity/title, tool visibility | Pending |
| Shell/background/sleep | tmux zsh PTY, bounded foreground wait, persistent jobs, input/EOF, scope ownership, cancellation, wakeups | Pending |
| Files/images | Bounded UTF-8 read, atomic write, exact unique edit, listing/search limits and skipped counts, images | Implemented; unit tested | |
| Swarm | User activation, worker tree/depth, worktrees and dirty choices, durable tasks, messages, observe/restart/review/stop/cleanup | Pending |
| Compaction | Codex native compaction, checkpoints, restore, manual/automatic controls | Pending |
| Fast mode | Priority tier request setting and persisted toggle | Pending |
| Models/reasoning | List/select models, supported reasoning, persistence | Pending |
| Usage/cost | Codex limits/reset information and API cost reporting | Pending |
| Sessions | New/resume/fork/tree/name/export, command discoverability | Pending |
| Skills | Shared and Stack-specific skills, read-before-use policy | Pending |
| Retry/approval | Retry settings and cancellation; Stack approval policy equivalents | Pending |

Runtime differences must be stated explicitly and tested at the actual API seam.
Do not replace a required feature with a stub or count an untested native feature
as verified. Network checks must not expose credentials.
