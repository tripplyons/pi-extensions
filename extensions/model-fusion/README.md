# Model fusion

Opt-in cheap-model coding with independent completion review. Luna is the native
Pi actor. Muse Spark **Contributor** and GLM Flash review its proposed completion.
Astra supplies bounded advice, never tools or a replacement actor.

## Use

```text
/fusion on
/fusion status
/fusion off
/fusion reload
```

- New sessions start disabled. Enabled state and the prior model selection are
  saved in the session, so reload/resume restores fusion after validating its
  configuration and authentication. The compact footer shows `fusion` while on.
  In-flight reviews and cadence counters are not restored.
- Enable/reload while idle. Enabling selects the configured actor at its configured
  reasoning level. Disabling restores the previous model and reasoning.
- Selecting a model yourself disables fusion without overriding your selection.
- Enable fusion before native compaction. A checkpoint from another actor model
  prevents activation without changing your current model. Start a new session
  or configure fusion's actor to match that checkpoint.
- The package manifest discovers this directory's `index.ts`. For isolated testing,
  use `pi --no-extensions -e /absolute/path/to/model-fusion/index.ts`.

## Flow

1. Luna performs the task using Pi's normal tools. Every 10 individual tool calls
   by default, both reviewers check a snapshot of recent progress in the background.
   Calls in a batch count separately; the review starts after the batch finishes.
   Luna keeps working. Each result posts its snapshot time, elapsed time, and how
   many more calls the actor completed. Findings steer a later turn and explicitly
   warn that newer work may already address them. Passes/failures without findings
   are informational messages and do not start extra actor turns.
   These checks do not consume completion repair rounds or automatically call Astra.
2. Both cheap reviewers independently inspect the candidate and main-context transcript.
3. Findings get one Luna repair round and a second review.
4. Unresolved findings get one eligible Astra advisory response, then one final
   Luna continuation. Automatic review stops there; this is not a guarantee that
   all findings were resolved.

One unavailable reviewer produces a visible degraded result. If no reviewer
returns a valid verdict, fusion attempts eligible frontier advice. Invalid JSON,
truncated responses, and request failures are not passing reviews. Fusion imposes
no advisory output-token cap; the request timeout still applies. Provider/SDK
output limits may still apply.

`fusion_escalate` lets the actor request frontier advice for a concrete blocker.
It shares the automatic escalation allowance: one immediate attempt per genuine
user prompt, then at least five minutes between further attempts on that prompt.
A new user prompt resets the allowance. Failed attempts consume it. The extension
never waits out the timer or retries automatically on a timer.

Completion reviews still block. They supersede and cancel unfinished progress
reviews. New prompts, session navigation, disabling fusion, and aborts also discard
pending results. Multiple progress snapshots may be in flight; timing labels
identify their order, rather than implying that a late result reviewed newer work.

## Goal loops

Goal continuations start another bounded review cycle, including when fusion was
turned on mid-goal. They do not reset the five-minute frontier allowance.
`update_goal` completion and blocked calls are reviewed before the tool can end
the run. Findings block that call and return repair instructions to the actor;
no follow-up is left waiting behind a terminating tool.

The final repair is still not independently re-reviewed. Reviewer outages or a
frontier cooldown produce an incomplete-review notice, not an endless goal gate.

## Configuration

Optional `~/.pi/agent/model-fusion.json` (under `PI_CODING_AGENT_DIR` if set):

```json
{
  "actor": {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "reasoning": "max"
  },
  "reviewers": [
    {
      "provider": "openrouter",
      "model": "meta/muse-spark-1.3-contributor",
      "reasoning": "low"
    },
    {
      "provider": "openrouter",
      "model": "z-ai/glm-5.3-flash",
      "reasoning": "medium"
    }
  ],
  "frontier": {
    "provider": "openai-codex",
    "model": "gpt-6-astra",
    "reasoning": "low"
  },
  "timeoutMs": 90000,
  "reviewEveryToolCalls": 10
}
```

These are the embedded defaults; no config file is required. Top-level omissions
use defaults. Each supplied slot requires `provider` and `model`; reasoning
omission means `low`. Configure 1–4 distinct reviewers. Unknown settings and
invalid values are rejected; failed reloads retain the working configuration.
Credentials come from Pi's registry, never this file. `reviewEveryToolCalls` accepts
1–1000. Remove the former `maxTokens` setting from existing overrides.
`/fusion reload` rereads this JSON; use Pi's `/reload` for extension code changes.

## Boundaries

- Only the actor has tools. Review/advice is fallible, not a majority-vote proof.
- Candidates can stream before review finishes. The status distinguishes pending
  review, repair, degraded review, and the end of the bounded cycle.
- Review and frontier packets include all user and assistant text from Pi's active
  main context, plus every tool call and textual result, including custom tools.
  New messages since the latest context snapshot are included. There is no overall
  packet cap and no truncation of user/assistant text or the review target.
  Each tool call's parameters are capped at 4,000 characters; each tool result at
  8,000 characters. Truncation is explicit. Compacted-away history and other
  branches are not replayed. Custom extension messages are not part of this transcript.
  A large main context can exceed a reviewer's context window and fail review.
- No additional files are read to build a review. System prompts, model reasoning,
  images, and native provider checkpoints are not included. **Tool text can still
  contain secrets, as can user/assistant text and tool arguments.** This is not a redaction system. Enable only with providers
  permitted to receive the task's code and output.
- Cancellation aborts pending requests; results from superseded tasks are ignored.
  It cannot undo edits already made by the actor.
- Native actor identity is retained for provider-specific extensions such as
  Codex compaction. Reviewers receive portable text, not opaque checkpoints.
- Normal actor usage and nested `fusion_escalate` usage use Pi accounting.
  Hook-driven progress and completion review calls are not included in Pi session totals; there is no
  custom cost/quota tracker. Do not read the footer as total fusion spending.
- Lower frontier reliance is the design objective, not a measured savings claim.
  A successful live test does not establish frontier-equivalent quality.

## Related implementations

The research informing this design includes
[Pi Mixture of Agents](https://github.com/EstebanForge/pi-mixture-of-agents),
[Hermes MoA](https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents),
and [Pi Model Router](https://github.com/yeliu84/pi-model-router).
This implementation uses a native actor and completion-review hooks rather than
copying their virtual-provider implementations.

## Tests

```sh
bun test extensions/model-fusion/policy.test.ts
bun test extensions/model-fusion/index.test.ts
bun test extensions/model-fusion/requests.test.ts
bun test extensions/model-fusion/rpc.integration.test.ts
```

Run test files separately: Bun module mocks are process-global. The RPC test uses
real Pi and a local fake inference server, including the actual goal extension's
terminating tool; it makes no paid calls.

The explicit live test creates a disposable coding fixture, uses all four default
models, loads Codex compaction alongside fusion, and checks the resulting file
with an unchanged test oracle. It makes paid calls and is not part of the default
suite:

```sh
python3 extensions/model-fusion/live-test.py
```

It prints the temporary directory containing the fixture and session evidence.
The live test expects the default model slots; use the deterministic tests for
custom configurations.
