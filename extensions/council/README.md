# Council

Select `tripp/council` or `tripp/council-openai` through `/model`. Reload Pi after
adding or updating this extension. It does not change the default model.
Both variants execute through GPT 6.1 Sol at medium effort with OpenAI priority.

## Council

`tripp/council` asks three independent advisors in parallel:

| Model | Effort | Service |
| --- | --- | --- |
| GPT 6.1 Sol (`gpt-6.1-sol`) | medium | OpenAI priority |
| GPT 6 Astra (`gpt-6-astra`) | medium | OpenAI priority |
| Claude Opus 5.5 (`claude-opus-5-5`) | low | Normal Anthropic service |

## Council OpenAI

`tripp/council-openai` asks two independent advisors in parallel. It requires no
Anthropic model or login.

| Role | Model | Effort | Service |
| --- | --- | --- | --- |
| Executor | GPT 6.1 Sol (`gpt-6.1-sol`) | medium | OpenAI priority |
| Advisor | GPT 6.1 Sol (`gpt-6.1-sol`) | high | OpenAI priority |
| Advisor | GPT 6 Astra (`gpt-6-astra`) | high | OpenAI priority |

## Execution

Sol receives every advisory answer, synthesizes them, and executes through the
session's normal tools. Each round permits 8 Sol responses and their tool
batches. Before the next response, the selected variant consults its advisors
using the work so far. Each new user message, including user steering, starts a
fresh round.
A finished task stops normally. Council never forces another agent turn.

Informational swarm messages, check-ins, review reminders, health alerts,
handoffs, and error-resume notices are notification wake-ups. When they are the
only new inputs, Council handles them with Sol without consulting advisors or
spending an execution slot, even at the 8-response boundary. Existing advice
stays internal and the next normal work request can refresh it. This also works
before the first consultation and after compaction. Real user inputs, parent
instructions, and tool follow-ups are not exempt.

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
model state, keyed by the selected virtual model. They survive reloads,
compaction, and session navigation. Switching variants does not share advice
or execution slots.
Advisory usage is stored there separately; Pi's native session usage totals do
not include these nested chat calls.

Advice is supplied as internal system context, not as a new user message or a
visible swarm message. The executor is instructed not to quote advisor blocks,
repeat consultation headers, or resynthesize advice just to answer a notification.
Cached answers are snapshots of earlier context, not live status reports.
Current swarm messages, assignments, permissions, jobs, and handoffs take
precedence over advisory status claims. The executor must check current evidence
and avoid repeated stale-advisor or completed-setup commentary.
Advice is guidance, not permission to act. This request-local context can reduce
prompt-cache reuse. Consultation adds three model requests per round for
Council, or two for Council OpenAI, in addition to execution.

## Authentication and fast mode

OpenAI models use the authenticated `openai` provider when available, or
`openai-codex` when it carries the exact model. No gateway or different model is
substituted. Only the original Council requires `anthropic` authentication for Opus.

Use `/login` and check `/model` if a required model is missing.
The package's ChatGPT-only billing guard also covers advisory calls.

Both variants request `service_tier: "priority"` for their OpenAI advisors and Sol
execution regardless of the global `/fast` toggle. It does not change that
toggle or request fast service for Anthropic. Priority is a request to the
provider, not a guarantee that priority service is granted.

Compaction summaries and other direct requests route to Sol at medium effort
without a consultation or a change to the execution budget. Background
compaction uses the same direct route. Its waiting/preparing/ready state stays
visible in the footer; both variants hide the separate reasoning-effort field.

## Tests

Run the offline checks with:

```sh
bun test extensions/council extensions/background-compaction/council.test.ts extensions/presentation/footer.test.ts tests/package.test.ts
```

The opt-in live smoke test makes real model requests using your existing login:

```sh
bun extensions/council/live-smoke.ts
```

It gives Sol only an in-memory counter tool. It verifies two three-model
consultations, nine separate tool responses, a final answer, exact efforts, and
OpenAI priority payloads. It does not save a session or expose file and shell
tools. Advisory calls can incur Anthropic API charges depending on your login.
