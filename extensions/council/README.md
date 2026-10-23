# Council

Council registers virtual models from `~/.pi/agent/councils.json`, or
`$PI_CODING_AGENT_DIR/councils.json` when that variable is set. Each key becomes
`tripp/<key>`; select one through `/model`. Reload Pi after editing the file. A
missing file registers no councils. An invalid file stops the extension from
loading and names the bad field. The extension does not change the default model.

```json
{
  "council-openai": {
    "name": "Council OpenAI",
    "executor": { "model": "gpt-6.1-sol", "providers": ["openai", "openai-codex"], "effort": "medium", "fast": true },
    "advisors": [
      { "model": "gpt-6.1-sol", "providers": ["openai", "openai-codex"], "effort": "high", "fast": true },
      { "model": "gpt-6-astra", "providers": ["openai", "openai-codex"], "effort": "high", "fast": true }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| key | Virtual model id: lowercase letters, digits, dots, and hyphens |
| `name` | Display name in `/model` |
| `executor` | The model that executes with the session's tools |
| `advisors` | One or more models consulted in parallel each round |
| `model` | Model id as Pi lists it under the provider |
| `providers` | Providers to try in order; the first with authentication wins |
| `effort` | `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `fast` | Optional, default `false`; request OpenAI priority service |

`fast` affects only `openai` and `openai-codex` requests. The global `/fast`
toggle does not apply to council requests. The tests use
[`fixtures.json`](fixtures.json), which holds the original two councils.

## Execution

The executor receives every advisory answer, synthesizes them, and executes
through the session's normal tools. Each round permits 10 executor responses and their tool
batches. Before the next response, the selected council consults its advisors
using the work so far. Each new user message, including user steering, starts a
fresh round.
A finished task stops normally. Council never forces another agent turn.

Informational swarm messages, check-ins, review reminders, health alerts,
handoffs, and error-resume notices are notification wake-ups. When they are the
only new inputs, Council handles them with the executor without consulting advisors or
spending an execution slot, even at the 10-response boundary. Existing advice
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
Images appear as placeholders; the executor still receives the original session images.
Each advisor has a 4,096-token output limit and a shared two-minute deadline.
A missing model, missing authentication, failed request, empty answer, truncated
answer, or attempted tool call stops execution. An advisor failure cancels its
siblings; Council never executes with partial advice.

The footer reports consultation progress and the current execution slot.
Advice, per-advisor usage, and the budget are saved in Pi's branch-local virtual
model state, keyed by the selected virtual model. They survive reloads,
compaction, and session navigation. Switching councils does not share advice
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
Advice is guidance, not permission to act. Each consultation appends internal
guidance at the end of the conversation as it stands when the round starts.
Council saves that position with the round state. Later requests retain earlier
guidance at its original positions, then append new conversation messages and
new round guidance. The initial system messages stay unchanged. Guidance uses
system-role messages inside the transcript, not the initial system-prompt block.

The execution-slot number stays in the footer, not the prompt. Notification
handling rules are part of the stable guidance. Tool turns, retries, and new
consultations can therefore extend the existing cached prefix instead of
rewriting it. The positions survive reloads and follow the session branch.
When compaction removes an insertion point, Council carries current advice to
the new conversation tail without consulting again. Legacy state gets an
insertion point on its next routed request.

Compaction, model or variant changes, and other prompt changes can still reduce
cache reuse. Provider cache hits are not guaranteed. Consultation adds one
model request per advisor each round, in addition to execution.

## Authentication and fast mode

Each member uses the first provider in its `providers` list that has the exact
model and authentication. No gateway or different model is substituted. Use
`/login` and check `/model` if a required model is missing. The package's
ChatGPT-only billing guard also covers advisory calls.

Members with `"fast": true` request `service_tier: "priority"` on OpenAI,
regardless of the global `/fast` toggle. Priority is a request to the provider,
not a guarantee that priority service is granted.

Compaction summaries and other direct requests route to the executor at its
configured effort without a consultation or a change to the execution budget.
Background compaction uses the same direct route. Its waiting/preparing/ready
state stays visible in the footer; councils hide the separate reasoning-effort
field.

## Tests

Run the offline checks with:

```sh
bun test extensions/council extensions/presentation/footer.test.ts tests/package.test.ts
```

The opt-in live smoke test makes real model requests using your existing login:

```sh
bun extensions/council/live-smoke.ts
```

It gives Sol only an in-memory counter tool. It verifies two three-model
consultations, eleven separate tool responses, a final answer, exact efforts, and
OpenAI priority payloads. It does not save a session or expose file and shell
tools. Advisory calls can incur Anthropic API charges depending on your login.
