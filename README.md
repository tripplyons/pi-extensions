# pi-extensions

26 extensions for [Pi](https://pi.dev/), installed as one package.

## Install

```sh
pi install git:https://github.com/tripplyons/pi-extensions.git
```

Run `pi config` to enable or disable individual extensions.
Update with `pi update --extensions`.
Do not also install copies under `~/.pi/agent/extensions/`.

For local development:

```sh
git clone https://github.com/tripplyons/pi-extensions.git
cd pi-extensions
pi install "$PWD"
```

Local edits load after `/reload` or a restart. No build step is needed.

## Dependencies

- Pi and Git.
- tmux and zsh for background jobs and worker sessions.
- OpenAI Codex authentication in Pi for Codex-specific features.
- uv for web search and extraction. The helper declares its Python dependencies.
- Neovim for `/nvim`.
- [codex-computer-use-mcp](https://www.npmjs.com/package/codex-computer-use-mcp) for `/computer-use`. Install separately with `pi install npm:codex-computer-use-mcp`.
- Bun and Python 3 for tests. Run `npm test` from the checkout.

Extensions run with your user permissions.

## Extensions

| Extension | What it does |
| --- | --- |
| agent-swarm | Manages worker trees, Git worktrees, and tmux sessions. Start with `/swarm:start`. |
| agents-md | Loads project instructions from `AGENTS.md`. |
| ask-user | Presents interactive question forms. |
| auto-rename | Names sessions automatically. |
| autocomplete | Adds editor completions for files, skills, and commands. |
| bg-bash | Runs persistent background shell jobs and provides `sleep`. |
| btw | Answers side questions with `/btw`. |
| clean-footer | Shows a compact session footer. |
| [codex-compaction](extensions/codex-compaction/README.md) | Adds native Codex compaction and `/threshold`. |
| codex-fast-mode | Toggles Codex fast mode with `/fast`. |
| computer-use-toggle | Toggles computer-use tools with `/computer-use`. |
| [context-compression](extensions/context-compression/README.md) | Adds selective summaries and retrieval. Enable with `/compression on`. |
| goal | Tracks goals and continues work automatically. Use `/goal`. |
| hide-empty-editor | Hides the empty editor. |
| message-window | Limits the visible transcript window. |
| [model-fusion](extensions/model-fusion/README.md) | Combines a Luna actor, background reviews every 10 tool calls, blocking completion checks, and bounded Astra advice. `/fusion on` persists per session and appears in the footer. |
| nvim-session-export | Exports the session to Neovim with `/nvim`. |
| openai-codex-usage | Reports Codex usage with `/usage`. |
| review | Runs code reviews with `/review`. |
| stash | Stashes and restores editor text with Ctrl+S. |
| subagent | Runs isolated asynchronous subagents. |
| syntax-punctuation | Styles syntax punctuation. |
| thinking-counter | Displays thinking progress. |
| tool-status-style | Provides shared tool rendering. |
| [tripp-autoresearch](extensions/tripp-autoresearch/README.md) | Runs experiment loops with benchmarks and keep/revert decisions. |
| web-search-and-extract | Searches the web and extracts page content. |

Agent Swarm reads optional settings from `<agent-dir>/agent-swarm.json`.
The agent directory defaults to `~/.pi/agent`; override it with `PI_CODING_AGENT_DIR`.
Autoresearch and web search include their skills. Web search also bundles its
CLI; no separate script installation is needed.

Bundled third-party code retains its licenses in
[`codex-compaction`](extensions/codex-compaction/LICENSE) and
[`tripp-autoresearch`](extensions/tripp-autoresearch/LICENSE).
