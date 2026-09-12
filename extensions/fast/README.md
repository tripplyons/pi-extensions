# Session fast mode

- `/fast` or Ctrl+F enables Codex priority requests. Toggle again to force standard requests.
- Ctrl+F replaces the editor's forward-character shortcut. Right arrow still moves the cursor.
- The footer shows `fast` while the override is enabled and clears when it is disabled.
- The override applies to subsequent chat requests using `openai-codex`.
  Other providers and independent subagent sessions are unchanged.
- Reloading, resuming, restarting Pi, and forking preserve the override in hidden
  session history. Forks inherit the state at their branch point.
- New sessions start without an override. Until fast mode is toggled, existing Codex
  settings determine the request tier.
- No global settings are written. Reasoning effort is unchanged.

This sets the request's `service_tier` to `priority` or `default`. Provider
availability and billing rules still apply. Conversion's separate background
requests and routing headers remain controlled by its own settings.
