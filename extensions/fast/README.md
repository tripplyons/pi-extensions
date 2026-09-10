# Session fast mode

- `/fast` enables Codex priority requests. Run it again to force standard requests.
- The footer shows `fast` while the override is enabled and clears when it is disabled.
- The override applies to subsequent chat requests using `openai-codex`.
  Other providers and independent subagent sessions are unchanged.
- Reloading, resuming, restarting Pi, and forking preserve the override in hidden
  session history. Forks inherit the state at their branch point.
- New sessions start without an override. Until `/fast` is used, existing Codex
  settings determine the request tier.
- No global settings are written. Reasoning effort is unchanged.

This sets the request's `service_tier` to `priority` or `default`. Provider
availability and billing rules still apply. Conversion's separate background
requests and routing headers remain controlled by its own settings.
