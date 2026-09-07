# Codex compaction

Set a session compaction threshold for any provider. For OpenAI Codex models,
use native remote compaction instead of a local text summary.

## Commands

- `/threshold` — show the current threshold.
- `/threshold 180k` or `/threshold 180000` — set it to 180,000 tokens.

The override persists across session restarts and reloads. The default is
200,000 tokens, or 150,000 for GPT-6 Astra.

Compaction runs after a completed tool batch or when the agent settles. An
unfinished task continues after successful compaction. Manual and overflow
compaction remain available.

## Requirements and behavior

- Native compaction requires an authenticated OpenAI Codex model in Pi.
- Conversation content is sent to the ChatGPT Codex Responses endpoint.
- The returned checkpoint is stored in the session and is model-specific.
- Other providers keep Pi's normal compaction behavior.
- Works with the bundled goal, autoresearch, and context-compression extensions.

Derived from `@ogulcancelik/pi-codex-compaction` 0.1.4. See [LICENSE](LICENSE).
