# pi-extensions

19 extensions for [Pi](https://pi.dev/): Codex conversion and 18 selected local extensions. This package supports Code mode only.

## Install

```sh
git clone https://github.com/tripplyons/pi-extensions.git
cd pi-extensions
git switch pi-codex-conversion
npm ci --omit=dev
npm install --prefix "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm" --legacy-peer-deps @howaboua/pi-codex-conversion@3.0.30
pi install "$PWD"
pi install npm:@howaboua/pi-codex-web-run@0.0.2
pi install npm:@howaboua/pi-codex-imagegen@0.0.3
pi install npm:@howaboua/pi-ask@0.0.8
```

The dependency in Pi's user-wide npm directory lets the addons import conversion. It is not registered separately with Pi. The three upstream additions bring the selected setup to 21 extensions. Do not also install canonical or Lite Codex conversion, or copies of these extensions under `~/.pi/agent/extensions/`.

Configure Code mode before starting a fresh session. See [conversion setup and migration](extensions/pi-codex-conversion/README.md). The sibling dotfiles repository manages installation and configuration. Local source edits load after `/reload` or a restart. Dependency changes require `npm ci --omit=dev` first.

## Dependencies

- Pi 0.84.4 or newer, Node.js 22.19 or newer, npm, and Git.
- OpenAI Codex authentication in Pi for Remote history/notes, web search, and image generation.
- Neovim for `/nvim`.
- Bun and Python 3 for tests. Run `npm test` from the checkout.

Extensions and subagents run with your user permissions, including shell and file-write access.

## Extensions

| Extension | What it does |
| --- | --- |
| [pi-codex-conversion](extensions/pi-codex-conversion/README.md) | Loads pinned upstream Code tools, context management, and Codex UI. |
| [agent-swarm](extensions/agent-swarm/README.md) | Runs bounded macOS worker hierarchies with review and controller-owned integration. |
| auto-rename | Names sessions automatically. |
| autocomplete | Adds editor completions for files, skills, and commands. |
| btw | Answers side questions with `/btw`; `/btw:tools` allows Code tools. |
| clean-footer | Shows session metrics and upstream extension statuses. |
| [complain](extensions/complain/README.md) | Records timestamped environment and tool issues for later review. |
| [fast](extensions/fast/README.md) | Toggles Codex priority requests for the session with `/fast`, without saving settings. |
| goal | Persists a long-running objective, budgets its work, and continues until complete, blocked, paused, or limited. |
| hide-empty-editor | Hides the empty editor. |
| message-window | Limits the visible transcript window and restores completed tool previews when rebuilding history. |
| nvim-session-export | Exports the local session to Neovim with `/nvim`. |
| stash | Stashes and restores editor text with Ctrl+S. |
| subagent | Runs asynchronous Code children; swarm attachment blocks new jobs. |
| syntax-punctuation | Styles syntax punctuation. |
| thinking-selector | Opens the active model's thinking-level picker with Ctrl+T. |
| thinking-counter | Displays thinking progress. |
| [tripp-autoresearch](extensions/tripp-autoresearch/README.md) | Runs experiment loops with benchmarks and keep/revert decisions. |
| usage | Shows current Codex limits in a dismissible `/usage` overlay. |

Autoresearch includes its skills and retains its [upstream license](extensions/tripp-autoresearch/LICENSE). Codex conversion is an npm dependency with its own license and attribution.
