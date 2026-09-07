# Hook examples

Copy an example into your session, adapt it, and mark it executable.
`<skill-dir>` is this directory's parent:

```bash
cp "<skill-dir>/examples/before/external-search.sh" /path/to/session/.auto/hooks/before.sh
chmod +x /path/to/session/.auto/hooks/before.sh
```

See the [hook skill](../SKILL.md) for input schemas and execution rules.

## `before/` — fires before each iteration

| Script | Purpose |
| --- | --- |
| [`external-search.sh`](before/external-search.sh) | Mine agent notes for a query and fetch external material via your search tool of choice. |
| [`qmd-search.sh`](before/qmd-search.sh) | Same shape, but targets a local [`qmd`](https://www.npmjs.com/package/qmd) BM25 / vector / rerank index over your project's markdown. |
| [`anti-thrash.sh`](before/anti-thrash.sh) | After N consecutive discards, emit a steer suggesting a structural rethink. |
| [`idea-rotator.sh`](before/idea-rotator.sh) | Surface the next unchecked bullet from `.auto/ideas.md` as a steer nudge. |
| [`hypothesis-reflection.sh`](before/hypothesis-reflection.sh) | On a discard, ask a cheap model to critique the failed hypothesis and propose adjacent directions. |
| [`context-rotation.sh`](before/context-rotation.sh) | Trim an oversized `.auto/prompt.md`, archiving the tail. |

## `after/` — fires after each `log_experiment`

| Script | Purpose |
| --- | --- |
| [`learnings-journal.sh`](after/learnings-journal.sh) | Append one human-readable line per run to `.auto/learnings.md`. |
| [`macos-notify.sh`](after/macos-notify.sh) | Fire a native macOS banner only when the run is a new best. |
| [`auto-tag-winners.sh`](after/auto-tag-winners.sh) | Tag every new best with a sortable git tag. |
