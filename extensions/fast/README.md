# Session fast mode

- `/fast` enables Codex priority requests. Run it again to force standard requests.
- The footer shows `fast` while the override is enabled and clears when it is disabled.
- The override applies to subsequent chat requests using `openai-codex`.
  Other providers and independent subagent sessions are unchanged.
- `/reload`, `/new`, `/resume`, forks, and restarting Pi clear the override.
  Until `/fast` is used, existing Codex settings determine the request tier.
- No settings or session entries are written. Reasoning effort is unchanged.

This sets the request's `service_tier` to `priority` or `default`. Provider
availability and billing rules still apply. Conversion's separate background
requests and routing headers remain controlled by its own settings.
