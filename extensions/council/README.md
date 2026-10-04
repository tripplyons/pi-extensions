# Council

Select `tripp/council` through `/model`. Reload Pi after adding this extension.
It does not change the default model.

Council asks three independent advisors in parallel:

| Model | Effort | Service |
| --- | --- | --- |
| GPT 6.1 Sol (`gpt-6.1-sol`) | medium | OpenAI priority |
| GPT 6 Astra (`gpt-6-astra`) | medium | OpenAI priority |
| Claude Opus 5.5 (`claude-opus-5-5`) | low | Normal Anthropic service |

Sol then receives all three answers, synthesizes them, and executes through the
session's normal tools. Each round permits 8 Sol responses and their tool
batches. Before the next response, Council consults all three again using the
work so far. Each new user or steering message starts a fresh round.
A finished task stops normally. Council never forces another agent turn.

## Limits and failure behavior

The budget bounds responses between consultations, not tool count, elapsed time,
or the whole task. A single response can issue several tools. Repeated rounds
have no overall limit. Automatic retries reuse the round and response slot.

Advisors cannot use tools or change files. They receive a text view of the
conversation, including tool calls and results but excluding private thinking.
The view keeps the last 120,000 characters when necessary and marks truncation.
Images appear as placeholders; Sol still receives the original session images.
Each advisor has a 4,096-token output limit and a shared two-minute deadline.
A missing model, missing authentication, failed request, empty answer, truncated
answer, or attempted tool call stops execution. An advisor failure cancels its
siblings; Council never executes with partial advice.

The footer reports consultation progress and the current execution slot.
Advice, per-advisor usage, and the budget are saved in Pi's branch-local virtual
model state. They survive reloads, compaction, and session navigation.
Advisory usage is stored there separately; Pi's native session usage totals do
not include these nested chat calls.

Advice is appended to each executor request without adding user messages to the
saved transcript. It is guidance, not permission to act. This request-local
suffix can reduce prompt-cache reuse. Consultation adds three model requests
per round, in addition to execution.

## Authentication and fast mode

OpenAI models use the authenticated `openai` provider when available, or
`openai-codex` when it carries the exact model. No gateway or different model is
substituted. Opus requires `anthropic` authentication.

Use `/login` and check `/model` if a required model is missing.
The package's ChatGPT-only billing guard also covers advisory calls.

Council requests `service_tier: "priority"` for both OpenAI advisors and Sol
execution regardless of the global `/fast` toggle. It does not change that
toggle or request fast service for Anthropic. Priority is a request to the
provider, not a guarantee that priority service is granted.

Compaction summaries and other direct requests route to Sol at medium effort
without a consultation or a change to the execution budget.

## Tests

Run the offline checks with:

```sh
bun test extensions/council/index.test.ts extensions/council/sdk.test.ts tests/package.test.ts
```

The opt-in live smoke test makes real model requests using your existing login:

```sh
bun extensions/council/live-smoke.ts
```

It gives Sol only an in-memory counter tool. It verifies two three-model
consultations, nine separate tool responses, a final answer, exact efforts, and
OpenAI priority payloads. It does not save a session or expose file and shell
tools. Advisory calls can incur Anthropic API charges depending on your login.
