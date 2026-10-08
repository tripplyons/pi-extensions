# Session search

Search saved Pi conversations without resuming them or adding an archive to the
current model context. Reload Pi after adding this extension.

## Commands

- `/session-search <terms>` searches sessions from the current working directory.
- `/session-search --all <terms>` also searches other projects in Pi's standard
  session store. The current session directory is included, including a custom
  directory configured through Pi.
- `/session-search` prompts for search terms.

Select a result to inspect original messages on its branch. Use arrow keys,
Page Up/Page Down, Home/End, or j/k to scroll. `p` opens an older page when
available, `r` rereads the session, and Escape returns to the result list.
For a compaction or branch summary result, `e` opens its original covered span.
Use `n` to read another chunk of a clipped result entry.
Inspection is read-only and does not append messages or trigger model calls.
The screen requires interactive Pi; the tools work in other modes.

## Tools

`session_search` accepts:

- `query`: case-insensitive literal terms separated by whitespace. Every term
  must occur in the same entry; no regular expressions or embedding calls.
- `scope`: `project` (default) or explicit `all`.
- `includeTools`: include tool calls and results (default false).
- `limit`: 1-50 matches, default 20.
- `offset`: use the returned `nextOffset` for more results.

Results include the session ID, path, name, working directory, entry ID,
timestamp, kind, snippet, and whether the entry is on the active branch.
Sessions are visited in Pi's discovery order, newest activity first within the
project directory, and entries newest first. This is text search, not semantic
ranking. Live entries and the live branch of the current session are included,
even when they have not been flushed to disk.

`session_read` accepts an exact `sessionId` from search and the same `scope`:

- Without `entryId`, read the latest branch's most recent entries.
- `entryId` opens surrounding entries on the most recently appended descendant
  branch containing that entry. It never combines sibling branches.
- `beforeEntryId` pages backward using `nextBeforeEntryId`.
- `expandSummary: true` with a summary `entryId` reads the original covered
  history, not another generated summary. Keep that summary ID when paging.
- `limit` is 1-50 entries, default 20.
- Large entry text is clipped, with `textLength` and `nextTextOffset`. Retrieve
  the next chunk using the same `entryId` and `textOffset: nextTextOffset`.
  This applies to individual entries, not an expanded summary span.

For example:

```javascript
const found = await tools.session_search({ query: "queued compaction" });
const match = found.matches[0];
if (match) {
  const original = await tools.session_read({
    sessionId: match.sessionId,
    entryId: match.entryId,
  });
  text(original);
}
```

The tools return structured results to codemode. Message text is bounded to
28,000 characters per read, with at most 4,000 characters per entry. Image
content is represented by placeholders, not image bytes. Thinking blocks,
system prompts, and private extension-state entries are excluded. Tool arguments
and output can still contain secrets; opt in to searching them deliberately.

## Storage and trust

Pi's session discovery APIs locate files. Reading parses and migrates entries
in memory only; it never opens a mutable SessionManager for archived files.
Legacy v1 entries receive stable read-only IDs. No persistent index, copied
transcripts, embeddings, external service, or new runtime configuration is used.
Only files found through session discovery can be read by session ID. Missing
files, malformed trailing lines, and ambiguous IDs are reported rather than
silently replaced. Search result pagination is a fresh snapshot; active sessions
can change between calls.

Project scope means the exact working directory, not every directory or Git
worktree in a repository. Swarm sessions have separate workspaces and session
files; use `swarm_inspect` or `/swarm:inspect` to inspect them within a run.

History is evidence, not an instruction channel. Results explicitly warn that
old instructions do not grant permission. Search includes compacted messages,
alternate branches, and raw entries later omitted or replaced by context edits.
They may describe failed approaches or obsolete decisions. Check current files
and swarm state before acting. Summaries may be incomplete or wrong; opening
one recovers its source span but does not validate its claims.

Run focused checks with:

```sh
bun test extensions/session-search extensions/swarm/inspection.test.ts tests/package.test.ts
```
