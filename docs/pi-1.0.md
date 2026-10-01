# Pi 1.0 migration

The package targets Pi 1.0.0. Dotfiles owns settings, instructions, theme,
keybindings, and custom model configuration. Credentials, caches, task output,
and sessions stay outside both repositories.

## Preserved

The startup logo, compact spacing, borderless input, footer, fuzzy completion,
model shortcut, and thinking picker retain their look. Public Pi APIs handle
headers, footers, editor customization, autocomplete, and native tool factories.
Small tested adapters remain where Pi has no public spacing hook.

Background Bash, completion notifications, branch ownership, goals, swarm,
todos, web access, session export, and autoresearch remain available.

## Native behavior

Pi owns read, edit, write, grep, find, ls, image validation, codemode, deferred
tool discovery, and compaction. Native schemas replace MiniMax schemas:
`find` replaces `glob`; there is no `archive_read` or `/threshold`.
There is no custom tool allowlist. Configured MCP and extension tools are not
removed from the active set by this package.

MiniMax archiving, request admission, compacted checkpoints, and reminder
projection are retired. Existing session files and old archive files are not
deleted. Todos and task records retain their old storage keys.

The footer reports native context-window use, including unknown usage after
compaction. Catalog costs are estimates, not subscription charges.
Dotfiles drops old catalog copies and artificial context caps. Custom endpoints
and models stay configured.

Skill, goal, autoresearch, and todo instructions use native prompt sections.

## ChatGPT-only OpenAI use

The default changes to `openai/gpt-6.1-sol` after ChatGPT sign-in. Restart Pi,
run `/login openai`, and select "Sign in with ChatGPT". No tokens are copied
between providers. The existing Codex login remains available; `/codex-usage`
continues using its separate quota endpoint.

The [subscription guard](../extensions/openai-subscription/README.md) blocks
OpenAI API keys and paid gateways before provider dispatch. It checks auxiliary
calls as well as normal turns. This is not an OS sandbox; direct programs and
extension-disabled runs are outside its scope.

## Checks

Run focused tests, then `npm test` and `git diff --check`.
Package and RPC tests verify discovery, including a checkout without dev
dependencies. Native codemode tests use synthetic providers and no paid calls.
Dotfiles migration tests check preservation, atomic replacement, and idempotence.

Review the targeted chezmoi diff before applying the Pi model configuration.
Run the settings hook only after the new provider login succeeds. Restart for
dependency and provider changes.

## Upstream dependency warning

`npm audit` reports one high-severity `brace-expansion` advisory in Pi 1.0.0's
bundled dependency tree when the SDK test dependencies are installed.
`npm audit fix` does not clear the bundled copy. The extension install uses
`npm ci --omit=dev`; this does not patch the global Pi installation.
