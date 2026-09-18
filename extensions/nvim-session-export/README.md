# Neovim session export

- `/nvim` exports the current branch as Markdown and opens it in Neovim.
- `/nvim --no-open path/to/session.md` only writes the export.

Exports include text, thinking, tool calls, and tool results. Images are omitted.
Without a path, exports go to `~/.pi/agent/exports/`. Existing output files are
overwritten. Opening requires `nvim` on PATH and an interactive terminal.
