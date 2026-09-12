# Codex Code mode

This directory loads `@howaboua/pi-codex-conversion@3.0.33` without a local fork. Upstream owns shell sessions, patches, tool rendering, context management, fast mode, and usage reporting.

## Configuration

Merge these fields into `~/.pi/agent/pi-codex-conversion.json`, or the corresponding file under `PI_CODING_AGENT_DIR`:

```json
{
  "executionMode": "code",
  "voiceFeaturesOnly": false,
  "compaction": {
    "contextManagement": "remote",
    "hybridCompaction": true,
    "responsesCompaction": true
  }
}
```

Preserve your other settings, including provider scope. The sibling dotfiles settings hook owns this merge. It does not require committing runtime configuration here.

- Code mode exposes `exec` and `wait`. Local subagent and autoresearch tools are available inside `exec` through `tools`.
- Direct context lifecycle tools, including `new_context`, remain upstream-owned.
- Remote history and notes require the Codex transport and authentication. They are encrypted service state, not local plaintext files.
- Trusted project `.pi/pi-codex-conversion.json` files can override global configuration. Check them if Code or Remote is missing. This package does not rewrite project overrides.
- Structured and Notebook modes are not supported by this collection. Select Code in upstream settings before use.

## Additional upstream packages

Install these separately, not through local wrappers. They dynamically import conversion from their own npm tree, so also run `npm install --prefix "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm" --legacy-peer-deps @howaboua/pi-codex-conversion@3.0.33`. Do not register that shared dependency with Pi. Only this checkout's loader activates conversion.

| Package | Code API |
| --- | --- |
| `@howaboua/pi-codex-web-run@0.0.2` | `tools.web__run(...)` |
| `@howaboua/pi-codex-imagegen@0.0.4` | `tools.image_gen__imagegen(...)` |
| `@howaboua/pi-ask@0.0.9` | `tools.ask({ prompts: [...] })` |

Use upstream schemas for each call. Ask requires an interactive TUI or RPC client. Web and image generation require Codex login. Keep generated `.pi/openai-codex-images/` output untracked.

## Retained workflows

- Subagents receive full Code tools, inherit the parent model and thinking level, and load only this conversion extension. There are no `write` or `tools` restrictions. Children can modify files and run shell commands. Completion arrives automatically.
- Autoresearch tools follow its actual activation state, including inside `exec`. Upstream supplies compaction. Recovery reads `.auto/prompt.md`, `.auto/log.jsonl`, ideas, and Git history. An upstream continuation consumes any pending local recovery rather than launching a duplicate turn.
- `/btw` blocks tool calls in its copied session. `/btw:tools` allows the child's configured Code tools rather than copying the parent's outer tool-name projection.
- The footer displays upstream statuses. `/nvim` exports the local session, not decrypted Remote history.

## Migration

- Start a fresh session after applying configuration and restarting Pi. Do not expect old selective-compression checkpoints to work with Remote history.
- Remove separate canonical or Lite conversion registrations and old copies of removed extensions. The manifest explicitly loads 13 entry points.
- Local swarm, goals, review, fusion, background bash, selective compression, and custom Codex compaction are removed. There is no replacement `sleep` tool.
- Existing tmux jobs and external state are not deleted or migrated. Upstream shell sessions do not adopt old background jobs.
- Pi itself handles `AGENTS.md`. Upstream ask and web tools replace the removed local question and web extensions.

## Verification

`npm test` includes real Pi package discovery and an isolated Code runtime test. The runtime executes shell, apply_patch, subagent_process, and an autoresearch experiment without a model request. It also checks that Remote does not fall back to local history when authentication or network access fails.

To include the three addons, set `PI_CODE_ADDON_DIR` to an npm prefix containing them and the pinned conversion dependency, then run `npm test`. The tests check all 16 entry points, addon Code names, and ask's blocking policy. They do not generate images, spend model tokens, or verify authenticated Remote service behavior.

Upstream source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion
