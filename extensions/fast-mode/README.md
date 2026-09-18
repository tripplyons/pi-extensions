# Fast mode

`/fast [on|off]` requests OpenAI priority service by adding `service_tier: priority`
to outgoing OpenAI/Codex payloads. Off initially; persisted on the session branch.
Changing to another provider disables it. Does not alter model or reasoning effort.
Priority availability and billing depend on the account; this does not promise
faster responses or silently purchase a separate subscription.
