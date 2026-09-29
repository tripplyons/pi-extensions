# Pi extensions

Pi extensions for coding tools, context management, background tasks, and session UI.

[MiniMax](extensions/minimax) is the always-on tool and context harness, not a
model selection. It replaces the old file, shell, pruner, and Codex-compaction
extensions; there is no `/minimax` toggle. `/threshold` still controls automatic
compaction. Other extensions, including `btw`, `goal`, and `presentation`, remain
installed with their existing activation rules.

## Extensions (21)

| Extension | Behavior |
| --- | --- |
| [web](extensions/web) | CLI web search and extraction with query/URL previews, elapsed time and text results |
| [swarm](extensions/swarm) | User-activated workers, messaging, review and worktrees |
| [ask-user](extensions/ask-user) | Free-text questions with numbered suggestions and plain-text answers |
| [autocomplete](extensions/autocomplete) | Fuzzy command, skill, and file completions |
| [complain](extensions/complain) | Private harness issue records in `~/.pi/agent/complaints` |
| [minimax](extensions/minimax) | Always-on file/Bash tools, optional built-in codemode, batched task notifications, paged search, archives, checkpoints and todos |
| [hide-empty-editor](extensions/hide-empty-editor) | Borderless, tinted input with no reserved blank rows; hidden while empty |
| [presentation](extensions/presentation) | Single-line tool spacing and input/compaction threshold footer; no working indicator |
| [startup-screen](extensions/startup-screen) | PI header and project-only resource lists |
| [skills](extensions/skills) | Skill-use instructions; native Pi discovery |
| [usage](extensions/usage) | Codex weekly quota and reset time |
| [models](extensions/models) | Model listing and selection |
| [thinking-selector](extensions/thinking-selector) | Ctrl+T reasoning effort picker |
| [fast-mode](extensions/fast-mode) | Opt-in priority service; Ctrl+F toggle |
| [overseer](extensions/overseer) | Terminal busy/attention glow |
| [goal](extensions/goal) | Persistent objectives and continuation; text result previews |
| [stash](extensions/stash) | Ctrl+S editor text stash |
| [auto-rename](extensions/auto-rename) | Automatic session names |
| [btw](extensions/btw) | Side questions with optional tools |
| [nvim-session-export](extensions/nvim-session-export) | Markdown session export to Neovim |
| [tripp-autoresearch](extensions/tripp-autoresearch) | Benchmark loops with keep/revert decisions |

Tool names use the footer folder's accent color; Bash calls color only the `$`
prefix. Preview arguments use the normal foreground color. Tool result previews
use readable text, including nested records and multiline output.
Structured data stays unchanged for the model and session history.

Complaint, MiniMax, and swarm files live under `~/.pi/agent`
(`PI_CODING_AGENT_DIR` overrides this). Harness session entries and events use
the `pi:` namespace. Previous storage locations and session keys are not migrated.

Implementation and runtime audits are ongoing.

Run `npm install` and `npm test` (requires Bun). Install with
`pi install /absolute/path/to/pi-extensions`. Reload Pi after installation or
updates. The manifest discovers entry points only, not adjacent tests.

Historical third-party license notices are retained under `licenses/`.
