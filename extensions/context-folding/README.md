# Context Folding

Lets the model fold finished parts of the conversation into its own summaries,
restore them, and search the originals.

## Tools

`context_status` reports context usage, active folds, and the entries that can
be folded. Each line is one user message, or one assistant turn with its tool
results, so its refs form a valid range:

```text
- 3f2a9c1b user ~120: fix the parser
- 7d41e0aa..b9c2f310 assistant + 1 results ~5,012 [read]: Reading.
```

`compress` takes `from`, `to`, and `summary`. The last entry in the range
carries the summary, and the other entries leave model context. If the last
entry is a tool result, its tool call stays beside it so the provider still
sees a complete pair. A range must not split a tool call from its result,
reach the current turn, or end at an interrupted turn, and the summary must be
shorter than the range.

Pi edits only user, assistant, tool result, and custom messages. Other entries
in a range, such as user `!` shell commands and stored system messages, stay
visible in place. `context_status` marks them `(stays visible)`, and `compress`
reports how many it kept.

`decompress` takes a fold ID such as `fold-1` and restores the entries as they
were before the fold. A fold can cover the carrier of an earlier fold; restore
the outer fold first.

`search_context` matches case-insensitive literal terms against the branch's
original messages, including folded and compacted ones, and reports whether
each match is visible, folded, or no longer in context.

## How folds are stored

Folds and restores apply at the end of the turn that requested them, after
their tool results are saved. Each one appends a `context-folding` custom entry
and native `context_edit` entries to the session. The session file keeps every
original message, and fold state follows `/tree`, forks, and reloads. Pi's
native compaction still runs at its usual threshold and summarizes the folded
context.

## Reminders

When `update_plan` completes a step whose entries hold at least 8,000 tokens,
a hidden message suggests folding the range from the previous plan update to
that turn. Without an unfinished plan, a hidden message suggests folding when
usage reaches 60% of the context window. It fires again only after usage falls
below 50%. No reminder is sent after a fold, at the end of a run, or while
online context compaction is stopping the run.

## Online context compaction

Each fold or restore emits `pi:context-fold` on `pi.events` with the tokens it
saves and the tokens the prompt cache must rewrite. The event waits for the
next turn, or for the run to settle, and is sent only if Pi committed the fold.
Pi drops every entry from a turn boundary when any of them is invalid. Online Context Compact adds
that rewrite to its cache debt and resets its growth baseline, so its cost model
does not treat a fold as free or as negative growth.

Ideas adapted from
[billion-context-pi](https://github.com/ranxianglei/billion-context-pi). See
`licenses/billion-context-pi.txt` for its MIT license.
