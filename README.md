# Pi extensions

Clean-room rework of Tripp's Stack Agent configuration for Pi. Work is on `rework`;
`main` is unchanged. No legacy extensions, conversion provider, patches, Mixture,
subagent framework, or compatibility shims are loaded.

## Extensions (5)

| Extension | Behavior |
| --- | --- |
| [ask-user](extensions/ask-user) | Free-text questions with cancellation |
| [complain](extensions/complain) | Private harness issue records |
| [context-pruner](extensions/context-pruner) | Archived context trimming and retrieval |
| [files](extensions/files) | Byte-range text, exact edits, search, listing, images |
| [goal](extensions/goal) | Persistent objectives and continuation |

The remaining target includes shell/background tools, swarm, compaction, fast mode,
model/reasoning controls, usage, sessions, skills, retry/approval policy,
autocomplete, overseer, and presentation. Implementation is in progress.

Run `npm test` (requires Bun). Install with `pi install /absolute/path/to/pi-extensions`.
The manifest discovers entry points only, never adjacent tests.

Historical third-party license notices are retained under `licenses/`.
