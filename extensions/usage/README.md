# Usage

`/usage` uses the selected model's provider:

- **Claude bridge (`claude-bridge`):** Displays the 5-hour and 7-day plan
  windows, with percent remaining and reset times, from the latest rate-limit
  event Claude Code sent with a bridge response. The output says how old that
  event is. Before the first Claude response in this Pi process, it links to
  https://claude.ai/settings/usage instead. The command reads
  `globalThis[Symbol.for("claude-bridge:rateLimits")]`, which the dotfiles bridge
  patch fills. It resolves no credentials and makes no request: the bridge's
  Pi OAuth token lacks the profile scope that the Claude usage endpoint needs.
- **OpenAI (`openai`):** Shows https://chatgpt.com/settings/usage for the new
  `/login openai` method, Sign in with ChatGPT. In-terminal quota is unavailable
  for this login. The command does not resolve credentials, make a network request,
  or fall back to a legacy Codex account. The link also works when an API key is
  configured, but shows ChatGPT plan usage, not API billing.
- **Legacy Codex (`openai-codex`):** Displays the weekly quota and, when the
  account has one, the 5-hour quota, with reset times. The command uses Pi's
  credential resolver, including refresh handling, then requests the legacy Codex
  usage endpoint. No token is written to disk, passed to a shell, included in
  notifications, or sent through redirects.

OpenAI's [Sign in with ChatGPT guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
point apps to ChatGPT usage settings. The new direct OAuth tokens do not work with
`https://chatgpt.com/backend-api/wham/usage`.

Legacy requests time out after 15 seconds, cap responses at 1 MiB, and are cancelled
on session/model changes or shutdown. An unlabelled primary window is treated as
weekly for Prime compatibility. Regression tests use synthetic credentials and
HTTP responses.

`/api-cost` totals assistant token usage and estimated API costs on the active
session branch, including failed responses with reported usage. It is not a
billing statement; subscription responses may report zero cost.

API cost is separately displayed by presentation using Pi's recorded usage cost.
Priority-tier pricing and compaction-cost completeness still need auditing.
