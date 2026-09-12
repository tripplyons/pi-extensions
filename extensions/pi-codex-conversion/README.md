# Codex without tool overrides

This directory loads pinned `@howaboua/pi-codex-conversion@3.0.33` without a local fork. Use its supported voice-only mode to leave Pi's tools intact. Normal execution mode alone does not disable upstream tool replacements.

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
    "responsesCompaction": false
  }
}
```

Keep native Pi compaction enabled in `settings.json`, with `reserveTokens: 60000`. Preserve unrelated preferences, voice settings, and provider scope. The dotfiles settings hook owns this merge; do not store runtime settings in this repository.

Trusted project `.pi/pi-codex-conversion.json` files can override the global policy. Check effective settings if upstream tools reappear. This package does not rewrite project overrides.

## Tools and child sessions

- Pi supplies `read`, `write`, and `edit`.
- Local bg-bash supplies `bash`, `bg_process`, and interruptible `sleep`.
- Local ask-user supplies `ask_user`; do not register npm `@howaboua/pi-ask` alongside it.
- Code `exec`/`wait`, upstream file replacements, and Remote context management are disabled under this policy.
- Subagents explicitly load conversion and bg-bash and inherit managed settings. Swarm and mixture workers receive private native settings and private shell state.
- Autoresearch retains its native activation rules. Pi owns compaction.

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
