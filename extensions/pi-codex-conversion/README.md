# Codex with local context

This wrapper loads pinned `@howaboua/pi-codex-conversion@3.0.33` without a fork. It owns local history, notes, and context windows while retaining upstream voice support and Pi's native tools. Upstream voice-only mode does not disable the wrapper's local context engine.

## Configuration

Merge these fields into `pi-codex-conversion.json` under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`:

```json
{
  "executionMode": "normal",
  "voiceFeaturesOnly": true,
  "tools": {
    "applyPatchOnly": false,
    "viewImageOnly": false,
    "autoReasoning": false
  },
  "compaction": {
    "contextManagement": "off",
    "hybridCompaction": false,
    "responsesCompaction": false,
    "portableSummary": false
  },
  "openai": {
    "forceCachedWebSockets": false,
    "proxyResponsesLite": false,
    "cacheKeepalive": false,
    "lunaCacheKeepaliveMinutes": 0,
    "cacheDiagnostics": "off"
  }
}
```

Keep native Pi compaction enabled in `settings.json`, with `reserveTokens: 60000`. Preserve unrelated preferences, voice settings, and provider scope. The dotfiles settings hook owns this merge; do not store runtime settings in this repository.

The wrapper refuses incompatible explicit remote-context, hybrid-compaction, Responses Lite, and cached-WebSocket settings before dispatch. Check both the global file and trusted project `.pi/pi-codex-conversion.json`. It does not rewrite either file.

## Tools and child sessions

- Pi supplies `read`, `write`, and `edit`.
- Local bg-bash supplies `bash`, `bg_process`, and interruptible `sleep`.
- Local ask-user supplies `ask_user`; do not register npm `@howaboua/pi-ask` alongside it.
- Code `exec`/`wait`, upstream file replacements, and Remote context management are disabled under this policy.
- Subagents explicitly load conversion and bg-bash and inherit managed settings. Swarm workers receive private native settings and private shell state. Mixture uses the current session's effective providers and native tool loop.
- Mixture tracks acquired role and summary request IDs. Helpers release their acquired ID when they finish. The wrapper cancels released local Codex requests without sweeping unrelated sockets.
- Autoresearch retains its native activation rules. Pi owns compaction.

## Local state and transport

`history`, `notes`, `new_context`, and `get_context_remaining` operate on local session state. Mixture lead, writer, and reviewer stores are separate. Reviewers can change their own notes and windows, not another role's notes or checkout files. Helper and summary inference has no tools.

A window change waits for the complete tool batch. Archived windows retain complete messages, including images, and remain searchable after leaving the active prompt. Notes are virtual files, limited to 1 MB per file and 10 MB per snapshot. Standalone stores use Pi custom entries and survive restart, compaction, forks, and tree navigation; sibling branches diverge independently. Mixture stores use its checkpoint/blob chain. Runtime state stays outside this repository.

Codex requests use SSE with the full local projection. The wrapper rejects injected continuation, remote history, and compaction fields after the payload callback and filters prohibited headers case-insensitively. Opaque correlation IDs are routing hints, not stored conversation history. Non-Codex Mixture providers bypass the Codex wire adapter.

`/codex-local` reports the active actor's window, archive and note counts, note bytes, and active Codex request count. It does not capture prompts, note paths or contents, branch IDs, headers, or credentials. Mixture's existing status/performance view retains its per-role request and usage accounting.

Responses Lite, remote compaction, cached WebSocket continuation, upstream prepared-prompt capture, and upstream cache diagnostics are not used by this adapter. Native Pi compaction remains available. The adapter reuses the pinned exported transport and transforms; its minimal request preparation is maintained here rather than in an upstream fork.

Existing upstream notes are left intact and are not imported automatically. Legacy Mixture checkpoints without local state initialize from role history. Malformed new local state is rejected rather than silently dropping notes.

## Optional upstream addons

Keep `@howaboua/pi-codex-web-run@0.0.2` and `@howaboua/pi-codex-imagegen@0.0.4` installed separately. Their native tools do not require Code mode. They require Codex authentication for service requests.

These addons dynamically import conversion from their npm tree. Keep the pinned conversion dependency there without registering a second conversion extension. Only this checkout's loader should activate it.

## Manual migration

1. Review the isolated extension and dotfiles changes before deploying them.
2. Apply the managed configuration explicitly. Remove npm pi-ask registration and duplicate conversion registrations.
3. Ensure tmux and zsh are installed. Restart Pi and start a fresh session.
4. Check the active tool list, including native file tools, bg-bash tools, and local `ask_user`.

Source edits do not update an already-running Pi session. Existing external state and shell jobs are not deleted. Detached tmux jobs can outlive worker process-group termination.

## Verification

Run focused tests, then `npm test` and `git diff --check`. Runtime tests must use temporary agent directories rather than live configuration. Test addon registration without authenticated requests; that does not prove live web or image service behavior.

Upstream source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion
