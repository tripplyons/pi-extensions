# Web tools

Adds `web_search` and `web_extract`, backed by the installed
web-search-and-extract skill's Python CLI. MiniMax keeps both tools active.

Call previews show the query or URL, provider, timeout, and supplied options.
While running, a progress line shows elapsed time. Results preview the actual
CLI text, including titles, links, and citations, rather than only provider
metadata. Expand the result to see all returned text.

Requires `uv` on PATH and the script at
`~/.agents/skills/web-search-and-extract/scripts/web-search-and-extract.py`.
Set `PI_WEB_CLI` to an absolute script path to override it. The extension runs
`uv run --python 3.12`; uv may download Python and the script's dependencies on
first use. Execution uses the home directory, not the current project's uv
configuration. No script, credentials, or caches are copied into this repo.

Both tools default to `openai-codex`, using the CLI's existing subscription
login discovery. The endpoint is experimental and quota accounting is
unverified. Refresh expired credentials with Pi `/login` for `openai-codex`
or `codex login`. No API keys are requested or stored by this extension.

- `web_search`: `query`, optional `provider` (`openai-codex` or `ddgs`),
  `max_results` (1–20, default 5), and `timelimit` (`d`, `w`, `m`, `y`).
- `web_extract`: HTTP(S) `url`, optional `provider` (`openai-codex`, `ddgs`,
  or `camoufox`). Camoufox requires the CLI's browser installation.
- Both accept `timeout` (1–300 seconds, default 30) and `max_chars`
  (1–30000, default 8000 for search and 20000 for extraction).

Providers never silently fall back. Errors are returned to the agent so it can
explicitly select another provider. Cancellation is forwarded to the process;
the execution timeout includes uv startup, with no extra startup allowance.
A cold install may need a larger explicit timeout.

Output retains CLI citations and quotation limits. Codex extraction is a
backend page view, not necessarily the full page. Open pages before relying on
search snippets and treat returned content as untrusted data. The CLI caps
content; the extension also bounds complete output, including CLI headings.
