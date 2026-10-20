# Pi extensions

Pi extensions for coding tools, context management, background tasks, and session UI.

Pi 1.2.0 or newer is required. Pi owns file/search tools, images, codemode, tool discovery, and compaction.
Background tasks remain a focused extension. The compact UI keeps its
look through public Pi APIs and tested spacing adapters. OpenAI requests require
ChatGPT OAuth; API keys and paid OpenAI gateways are blocked before dispatch.
See [the migration notes](docs/pi-1.0.md) for changes and sign-in.

## Extensions (32)

| Extension | Behavior |
| --- | --- |
| [web](extensions/web) | CLI web search and extraction with query/URL previews, elapsed time and text results |
| [swarm](extensions/swarm) | Isolated workers with messaging, reviews, reload barriers, health checks, saved-conversation inspection, and T3 Code running-state reporting |
| [session-search](extensions/session-search) | Local project-history search with original-message retrieval, summary expansion and a read-only inspector |
| [ask-user](extensions/ask-user) | Free-text questions with numbered suggestions and plain-text answers |
| [autocomplete](extensions/autocomplete) | Fuzzy command, skill, and file completions |
| [codemode-timeout](extensions/codemode-timeout) | Five-minute maximum for codemode scripts, including calls without a timeout |
| [complain](extensions/complain) | Private harness issue records in `~/.pi/agent/complaints` |
| [tasks](extensions/tasks) | Native Bash with reload-safe background tasks, T3 Code running-state reporting, opt-in pipeline failure detection, bounded output, and progress reports |
| [python](extensions/python) | Inline Python with uv, script-defined dependencies and Python versions, and managed background tasks |
| [action-fusion](extensions/action-fusion) | Optional `then_run` command on edit and write, run after the change lands |
| [observation-pack](extensions/observation-pack) | Large tool results replaced by excerpts after two requests, with `obs_recall` paging |
| [evidence-preserving-reducer](extensions/evidence-preserving-reducer) | Long build and test logs reduced by GPT 6 Luna to receipts with verified quotes |
| [online-context-compact](extensions/online-context-compact) | `update_plan` steps that compact context at step boundaries when it saves cost |
| [openai-subscription](extensions/openai-subscription) | ChatGPT-only OpenAI auth, billing guard, and native retry classification for interrupted responses |
| [hide-empty-editor](extensions/hide-empty-editor) | Borderless, tinted input with no reserved blank rows; hidden while empty |
| [presentation](extensions/presentation) | One-row tool previews with group separators only, streaming arguments and progress, expanded output, and context footer with reserved background status; no working indicator or hidden-thinking placeholders |
| [startup-screen](extensions/startup-screen) | PI header and project-only resource lists |
| [skills](extensions/skills) | Skill-use instructions; native Pi discovery |
| [usage](extensions/usage) | ChatGPT usage link, legacy Codex weekly quota, and API cost |
| [models](extensions/models) | Model listing and selection |
| [lm-studio](extensions/lm-studio) | Local LM Studio provider with model discovery, catalog-based thinking levels, and catalog refresh |
| [council](extensions/council) | Councils from `councils.json` with append-only round guidance, 10-response execution rounds, and advisor-free swarm notification handling |
| [extension-manager](extensions/extension-manager) | `/extensions` menu to enable or disable installed extensions globally |
| [thinking-selector](extensions/thinking-selector) | Ctrl+T reasoning effort picker |
| [fast-mode](extensions/fast-mode) | Opt-in priority service; Ctrl+F toggle; inherited by new swarm workers |
| [goal](extensions/goal) | Persistent objectives and steering continuation; text result previews |
| [stash](extensions/stash) | Ctrl+S editor text stash |
| [auto-rename](extensions/auto-rename) | Session names from the first user message using GPT 6 Luna with low reasoning and fast mode |
| [btw](extensions/btw) | Side questions with optional tools |
| [background-compaction](extensions/background-compaction) | Background summaries prepared at 80% of Pi's compaction threshold, with waiting/preparing/ready status |
| [nvim-session-export](extensions/nvim-session-export) | Markdown session export to Neovim |
| [tripp-autoresearch](extensions/tripp-autoresearch) | Benchmark loops with steering continuation and keep/revert decisions |

Tool names use the footer folder's accent color; Bash calls color only the `$`
prefix. Preview arguments use the normal foreground color. Collapsed calls show one row with a key argument and result/status summary.
Expansion restores specialized output, including diffs, images, nested records,
and multiline output.
Structured data stays unchanged for the model and session history.

Complaint, task, and swarm files live under `~/.pi/agent`
(`PI_CODING_AGENT_DIR` overrides this). Harness session entries and events use
the `pi:` namespace. Task storage keys remain readable by the new
extensions. Existing sessions and archive files are not deleted.

Implementation and runtime audits are ongoing.

Run `npm install` and `npm test` (requires Bun). Install with
`pi install /absolute/path/to/pi-extensions`. Reload Pi after installation or
updates. The manifest discovers entry points only, not adjacent tests.

The Pi pane glow lives in the [Overseer repository](https://github.com/tripplyons/overseer)
and is installed separately with `sh ../overseer/scripts/install-pi-hooks.sh`.
It is not bundled here, so only one extension controls the glow.

Historical third-party license notices are retained under `licenses/`.
Action Fusion, ObservationPack, Evidence-Preserving Reducer, and Online Context
Compact are adapted from [SoL-Pi](https://github.com/NVlabs/SoL-Pi) under its
MIT license (`licenses/sol-pi.txt`).
