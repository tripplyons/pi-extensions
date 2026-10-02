# Usage

`/codex-usage` uses the selected model's provider:

- **OpenAI (`openai`):** Shows https://chatgpt.com/settings/usage for the new
  `/login openai` method, Sign in with ChatGPT. In-terminal quota is unavailable
  for this login. The command does not resolve credentials, make a network request,
  or fall back to a legacy Codex account. The link also works when an API key is
  configured, but shows ChatGPT plan usage, not API billing.
- **Legacy Codex (`openai-codex`):** Displays weekly quota and reset time for the
  current Codex account. Five-hour quota is not displayed. The command uses Pi's
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
