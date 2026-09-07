---
name: web-search-and-extract
description: "Search the web, discover current sources, and extract URLs to markdown. Use for current facts, broad web research, or reading source pages."
---

# Web Search and Extract

The registered `web_search` and `web_extract` tools are authoritative. Use them whenever they are available; do not replace them with an ad hoc shell command. Follow the provider options exposed by the active tool schema: Pi supports Codex-first routing, while the Claude plugin wraps the local DDGS/Camoufox CLI.

- Pi's `web_search` supports `auto`, `codex`, and `ddgs`, plus `maxResults`, `region`, `timelimit`, and DDGS `backend`.
- Pi's `web_extract` supports `auto`, `codex`, `ddgs`, and `camoufox`, plus the Camoufox `timeout`.
- Pi's `auto` tries OpenAI Codex first, then the shared DDGS/Camoufox executable. Session-local web mode makes `auto` local-only and rejects explicit `codex`.
- Claude's plugin tools run the shared CLI directly: search uses DDGS, and extraction uses DDGS with Camoufox fallback in `auto` mode.

## Workflow

1. Use `web_search` with a narrow query and the default small result set. Add `timelimit` or `region` when recency or geography matters.
2. Treat search snippets as leads. Use `web_extract` on the best primary-source URLs before relying on exact facts.
3. Keep provider `auto` unless isolating `codex`, `ddgs`, or `camoufox` for diagnosis. In local web mode, use only `auto`, `ddgs`, or `camoufox`.
4. Use browser automation instead for authentication, clicks, screenshots, or other stateful flows.

If the registered tools are unavailable, use the bundled executable. Resolve this
SKILL.md's real path first (it may be symlinked). From its containing directory,
`../../web-search-and-extract` is the CLI. Substitute that absolute path for
`<cli>` below; do not resolve it against the current working directory.

```bash
<cli> search "query" --max-results 5
<cli> search "query" --timelimit w --region us-en
<cli> extract "https://example.com"
<cli> extract "https://example.com" --provider ddgs
<cli> extract "https://example.com" --provider camoufox --timeout 10
```

The fallback executable searches with DDGS. Extraction tries DDGS first and then rendered Camoufox in `auto` mode, rejects empty or bot-check pages, writes markdown-oriented text to stdout, and writes fallback diagnostics to stderr.
