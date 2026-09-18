# Pi extensions

Clean-room rework of Tripp's Stack Agent configuration for Pi. Work is on `rework`;
`main` is unchanged. No legacy extension bundle, conversion provider, Mixture,
subagent framework, or compatibility shims are loaded.

## Extensions (23)

| Extension | Behavior |
| --- | --- |
| [swarm](extensions/swarm) | User-activated workers, messaging, review and worktrees |
| [ask-user](extensions/ask-user) | Free-text questions with cancellation |
| [autocomplete](extensions/autocomplete) | Fuzzy command, skill, and file completions |
| [complain](extensions/complain) | Private harness issue records |
| [context-pruner](extensions/context-pruner) | Archived context trimming and retrieval |
| [hide-empty-editor](extensions/hide-empty-editor) | Borderless, tinted input; hidden while empty |
| [presentation](extensions/presentation) | Compact display and status footer; no working indicator |
| [startup-screen](extensions/startup-screen) | PI header and project-only resource lists |
| [skills](extensions/skills) | Stack and shared skill discovery |
| [codex-compaction](extensions/codex-compaction) | Opaque Codex checkpoints |
| [usage](extensions/usage) | Codex quota and reset times |
| [models](extensions/models) | Model listing and selection |
| [thinking-selector](extensions/thinking-selector) | Ctrl+T reasoning effort picker |
| [fast-mode](extensions/fast-mode) | Opt-in priority service; Ctrl+F toggle |
| [overseer](extensions/overseer) | Terminal busy/attention glow |
| [shell](extensions/shell) | Persistent tmux PTY jobs and wakeable waits |
| [files](extensions/files) | Byte-range reads, search, listing, images; no edit/write tools |
| [goal](extensions/goal) | Persistent objectives and continuation |
| [stash](extensions/stash) | Ctrl+S editor text stash |
| [auto-rename](extensions/auto-rename) | Automatic session names |
| [btw](extensions/btw) | Side questions with optional tools |
| [nvim-session-export](extensions/nvim-session-export) | Markdown session export to Neovim |
| [tripp-autoresearch](extensions/tripp-autoresearch) | Benchmark loops with keep/revert decisions |

The remaining target includes swarm, compaction, usage, sessions,
retry/approval policy. Runtime audits are also pending; see
[the parity checklist](docs/parity.md). Implementation is in progress.

Run `npm test` (requires Bun). Install with `pi install /absolute/path/to/pi-extensions`.
The manifest discovers entry points only, never adjacent tests.

Historical third-party license notices are retained under `licenses/`.
