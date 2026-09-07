# Context compression

Summarize older conversation sections to reduce context usage. Available for all
Pi models; disabled by default.

## Commands

- `/compression` — toggle compression.
- `/compression on` — enable summaries and retrieval tools.
- `/compression off` — stop applying summaries and restore available originals.

The setting persists with the session. The footer shows `compression` when enabled.

## Tools

The agent receives references to older messages and can call:

| Tool | Use |
| --- | --- |
| `compress` | Replace a range with a summary using `startId`, `endId`, and `summary`. |
| `search_context` | Search summaries and originals by literal, case-insensitive `query`. An empty query lists summaries. |
| `decompress` | Read original text using `blockId` and an optional character `offset`. |

Summaries must save at least 200 characters. User messages, recent messages,
images, and incomplete tool interactions stay visible. Search returns up to ten
matches; retrieval returns up to 8,000 characters per call. Use `offset` to continue.

## Limits

- Summaries can omit details. Originals remain in the session log for retrieval.
- Turning compression off cannot undo Pi compaction or a native Codex checkpoint.
- Compression can invalidate cached context and does not guarantee lower costs.
- Avoid other context-rewriting extensions. Remove `tool-pruner` if installed.
