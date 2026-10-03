# Pi extensions

Pi extensions for coding tools, context management, background tasks, and session UI.

Pi 1.0.1 or newer is required. Pi owns file/search tools, images, codemode, tool discovery, and compaction.
Background tasks and todos remain focused extensions. The compact UI keeps its
look through public Pi APIs and tested spacing adapters. OpenAI requests require
ChatGPT OAuth; API keys and paid OpenAI gateways are blocked before dispatch.
See [the migration notes](docs/pi-1.0.md) for changes and sign-in.

## Extensions (23)

| Extension | Behavior |
| --- | --- |
| [web](extensions/web) | CLI web search and extraction with query/URL previews, elapsed time and text results |
| [swarm](extensions/swarm) | Isolated workers with reload barriers, read-only permission waits, source versions, reviews and health checks |
| [ask-user](extensions/ask-user) | Free-text questions with numbered suggestions and plain-text answers |
| [autocomplete](extensions/autocomplete) | Fuzzy command, skill, and file completions |
| [complain](extensions/complain) | Private harness issue records in `~/.pi/agent/complaints` |
| [tasks](extensions/tasks) | Native Bash with failure diagnostics, reload-safe tasks, bounded UTF-8 output and opt-in progress reports |
| [todos](extensions/todos) | Persistent branch-local task lists |
| [openai-subscription](extensions/openai-subscription) | ChatGPT-only OpenAI auth; blocks API keys and paid OpenAI gateways |
| [hide-empty-editor](extensions/hide-empty-editor) | Borderless, tinted input with no reserved blank rows; hidden while empty |
| [presentation](extensions/presentation) | One-row previews for all tools, expanded output, and native context-window footer; no working indicator |
| [startup-screen](extensions/startup-screen) | PI header and project-only resource lists |
| [skills](extensions/skills) | Skill-use instructions; native Pi discovery |
| [usage](extensions/usage) | ChatGPT usage link, legacy Codex weekly quota, and API cost |
| [models](extensions/models) | Model listing and selection |
| [thinking-selector](extensions/thinking-selector) | Ctrl+T reasoning effort picker |
| [fast-mode](extensions/fast-mode) | Opt-in priority service; Ctrl+F toggle; inherited by new swarm workers |
| [overseer](extensions/overseer) | Terminal busy/attention glow |
| [goal](extensions/goal) | Persistent objectives and steering continuation; text result previews |
| [stash](extensions/stash) | Ctrl+S editor text stash |
| [auto-rename](extensions/auto-rename) | Automatic session names |
| [btw](extensions/btw) | Side questions with optional tools |
| [nvim-session-export](extensions/nvim-session-export) | Markdown session export to Neovim |
| [tripp-autoresearch](extensions/tripp-autoresearch) | Benchmark loops with steering continuation and keep/revert decisions |

Tool names use the footer folder's accent color; Bash calls color only the `$`
prefix. Preview arguments use the normal foreground color. Collapsed calls show one row with a key argument and result/status summary.
Expansion restores specialized output, including diffs, images, nested records,
and multiline output.
Structured data stays unchanged for the model and session history.

Complaint, task, and swarm files live under `~/.pi/agent`
(`PI_CODING_AGENT_DIR` overrides this). Harness session entries and events use
the `pi:` namespace. Task and todo storage keys remain readable by the new
extensions. Existing sessions and archive files are not deleted.

Implementation and runtime audits are ongoing.

Run `npm install` and `npm test` (requires Bun). Install with
`pi install /absolute/path/to/pi-extensions`. Reload Pi after installation or
updates. The manifest discovers entry points only, not adjacent tests.

Historical third-party license notices are retained under `licenses/`.
