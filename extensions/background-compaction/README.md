# Background compaction

Prepares the compaction summary before Pi needs it, so automatic compaction
does not wait for a summary request.

After each turn, the extension checks context usage. When usage reaches 60% of
Pi's compaction threshold (`contextWindow - reserveTokens`), it summarizes the
entries before Pi's usual cut point in the background. It uses Pi's own
compaction prompt, the session model and thinking level, and the
`compaction.reserveTokens` and `compaction.keepRecentTokens` settings,
including per-model overrides. When about 8,000 more tokens can be summarized,
it updates the stored summary with only the new entries.

When Pi compacts, the extension returns the stored summary from
`session_before_compact`. Pi keeps every entry after the stored cut point, so
the kept context can be larger than `keepRecentTokens`. While a refresh runs,
compaction uses the stored summary if it still fits the limits below. It waits
for the running summary only when no stored summary fits.

The footer shows `background: ready` when compaction would use the stored
summary at once, including while a refresh runs. It shows
`background: preparing` while a summary runs and no stored summary fits. The
status clears after compaction, tree navigation or a change to the summarized
entries.

Pi writes the summary itself when:

- `/compact` has custom instructions.
- The summarized entries changed, for example through a context edit, tree
  navigation or another compaction.
- The stored cut keeps more than 16,000 tokens beyond `keepRecentTokens`, or
  the kept context plus the summary would use 75% or more of the threshold.
- No background summary exists yet or the last one failed. A failure shows one
  warning per session.

Read and modified file lists are appended to the summary and carried forward
like Pi's own compactions. Summary usage is recorded on the compaction entry.
Background summaries that are never used still cost tokens.
