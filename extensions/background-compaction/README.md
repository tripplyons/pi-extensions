# Background compaction

Prepares the compaction summary before Pi needs it, so automatic compaction
does not wait for a summary request.

After each turn, the extension checks context usage. When usage reaches 75% of
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

When compaction is enabled, the footer always shows its state:

- `background: waiting`: no usable summary exists and no summary is running.
- `background: preparing`: a summary is running and no stored summary fits.
- `background: ready`: compaction can use the stored summary at once, including
  while an incremental refresh runs.

After compaction, model selection, or tree navigation, the state returns to
`waiting`. Disabled compaction and session shutdown clear it. The presentation
extension reserves room for this state in its one-line footer, so other statuses
cannot push it off-screen. Very narrow terminals can still shorten the state.

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

Virtual models work through Pi's direct-request routing. With `tripp/council`
or `tripp/council-openai`, Sol writes the background summary at medium effort without consulting advisors
or spending an executor response slot. Council's advice and budget stay in
branch-local state when the summary is applied. The footer omits Council's
selected effort because its presets already fix each model's effort.

Run the Council integration check with:

```sh
bun test extensions/background-compaction/council.test.ts
```

The opt-in live check uses existing logins and makes real requests:

```sh
bun extensions/background-compaction/live-smoke.ts
```

It seeds an in-memory conversation, prepares and applies a background summary,
checks the footer and Council state, and asks Council to answer after compaction.
It temporarily lowers the background preparation threshold in its own process.
It saves no session and exposes no file or shell tools.
