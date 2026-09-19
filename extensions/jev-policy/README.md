# Jev policy

Uses `typesafe/jev-1.13` through OpenRouter's Decisions API. The conversation stays
on its selected provider and model; Astra continues using the OpenAI subscription.
Jev requests use OpenRouter credits separately.

After reloading Pi, configure OpenRouter credentials through Pi's provider setup
or `OPENROUTER_API_KEY` in the environment that launches Pi. Credentials stay
outside this repository. `/jev` shows policy state; `/jev on|off` persists the
choice on the active session branch. The policy defaults on. Missing credentials
leave context intact, with a footer notice. Jev only makes pruning decisions;
reasoning effort stays under manual control.

- `/pruner on` enables importance-ranked pruning. Older eligible tool interactions
  trigger automatic pruning at 100 KB or more, targeting 50 KB or less.
  Jev scores importance and the highest-scoring
  interactions that fit stay. The rest are archived, without a score cutoff.
  Ties favor newer interactions. All candidates are scored before pruning, in
  batches of up to eight interactions and 16 KB, within the same model request.
  A failed batch retains the entire pool. `/prune` applies the same budget manually.
  The newest five eligible interactions and protected content are outside the budget.
- Recent interactions, skill reads, incomplete calls, archive retrievals,
  reasoning, images, oversized candidates, and checkpoint-covered calls remain
  protected. New checkpoints record covered call IDs; old checkpoints without
  that metadata conservatively prevent new pruning. Original history and
  archive retrieval remain available.

Each evaluation has an eight-second network timeout, no retries, and a 28 KB
serialized input limit. Oversized inputs, malformed answers, missing credentials,
and network failures retain context. Session navigation or model
changes cancel pending decisions. MiniMax mode bypasses this policy.

Each pruning batch fills the remaining 28 KB input budget with up to 32 nonempty
user/assistant messages and readable compaction/branch summaries. Tool-only
assistant messages do not consume history slots. The latest user request, latest
compaction and branch summaries, and latest assistant text get priority; remaining
space goes to recent conversation, returned in chronological order. Each excerpt
is capped at 4 KB (less when the history budget is small), preserving its beginning
and end with a truncation marker. Missing summaries fall back to the latest readable
summaries on the active branch. Opaque Codex checkpoints cannot be read by Jev and
are not sent.

Pruning sends eligible tool arguments/results, conversation excerpts, and readable
summaries to OpenRouter and TypeSafe. Reasoning blocks, system prompts, binary attachments, and credentials are not included as
context. Tool text can contain project data; the normal OpenRouter/provider data
policies apply. No source context is logged by this extension.

Compaction timing and thresholds are unchanged. The policy never selects a model,
spawns workers, or generates a compaction summary. `/jev off` restores the prior
pruner selection rules. Live decision quality and subscription savings need to
be measured on real tasks; offline tests only establish integration behavior.

API reference: https://github.com/OpenRouterTeam/ai-sdk-provider#evaluation-jev-with-ai-sdk-through-openrouter
