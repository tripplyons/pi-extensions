# OpenAI subscription guard

OpenAI requests must use credentials resolved by Pi's ChatGPT OAuth flow.
For the native OpenAI provider, the stored OAuth grant must include
`chatgpt.tokens.use.direct`. Opaque access tokens are supported. Existing
OpenAI Codex OAuth remains allowed.

The provider guard rejects environment keys, stored API keys, unverified
`--api-key` overrides, billing headers, and API keys disguised as OAuth.
Compaction can reuse a token that this guard already resolved through OAuth,
even when Pi passes it through a parameter named `apiKey`.
The API-key login option is removed. The guard runs before provider dispatch,
not in a lifecycle hook whose errors Pi catches and ignores.

Configured providers receive guards at session startup and before agent runs.
Chat, compaction, title generation, deferred responses, classifiers, and images
use these provider guards. Recognizable OpenAI models through paid gateways
and Azure endpoints are blocked; other providers retain their auth and behavior.
Only the native OpenAI Responses endpoint and the Codex subscription endpoint
are allowed for OpenAI models.

Access tokens stay in process memory and never enter logs or this repo.
Tests use synthetic credentials and provider implementations, with no paid
requests.

## Sign in

Restart Pi, run `/login openai`, and choose "Sign in with ChatGPT".
Use `/model openai/gpt-6.1-sol` after login.

## Boundary

This is an accidental-billing guard for Pi's registered providers, not an OS
sandbox. Disabling extensions, replacing a guarded provider after startup, or
calling another program or HTTP API directly can bypass it. Gateways that hide
the upstream model's identity cannot be identified reliably.
