# Pi extensions

Clean-room rework of Tripp's Stack Agent configuration for Pi. Work is on `rework`;
`main` is unchanged. No legacy extensions, conversion provider, patches, Mixture,
subagent framework, or compatibility shims are loaded.

## Extensions (13)

| Extension | Behavior |
| --- | --- |
| [ask-user](extensions/ask-user) | Free-text questions with cancellation |
| [complain](extensions/complain) | Private harness issue records |
| [context-pruner](extensions/context-pruner) | Archived context trimming and retrieval |
| [presentation](extensions/presentation) | Compact display and status footer |
| [skills](extensions/skills) | Stack and shared skill discovery |
| [codex-compaction](extensions/codex-compaction) | Opaque Codex checkpoints |
| [usage](extensions/usage) | Codex quota and reset times |
| [models](extensions/models) | Model listing and reasoning controls |
| [fast-mode](extensions/fast-mode) | Opt-in priority service |
| [overseer](extensions/overseer) | Terminal busy/attention glow |
| [shell](extensions/shell) | Persistent tmux PTY jobs and wakeable waits |
| [files](extensions/files) | Byte-range text, exact edits, search, listing, images |
| [goal](extensions/goal) | Persistent objectives and continuation |

The remaining target includes swarm, compaction, usage, sessions,
retry/approval policy, and autocomplete. Runtime audits are also pending; see
[the parity checklist](docs/parity.md). Implementation is in progress.

Run `npm test` (requires Bun). Install with `pi install /absolute/path/to/pi-extensions`.
The manifest discovers entry points only, never adjacent tests.

Historical third-party license notices are retained under `licenses/`.
