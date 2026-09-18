# Skills

Adds Stack's skill roots to Pi's native resource discovery on startup and reload:

- `<workspace>/.stack-agent/skills`
- `<workspace>/.agents/skills`
- `$XDG_CONFIG_HOME/stack-agent/skills` (default `~/.config/stack-agent/skills`)
- `~/.agents/skills`

Only existing roots are passed to Pi. Pi owns parsing, diagnostics, deduplication,
`/skill:name` expansion, completion, and its normal project/global skill roots.
Explicit-only skills remain available to the user but not in the model catalog.
The prompt requires reading SKILL.md before use and resolving references against
its directory. Stack-specific skill content remains unchanged; a skill about
Stack complaints does not grant authority to repair unrelated projects.

Difference: conflicts with Pi's existing catalog follow Pi's precedence, not
Stack's standalone first-root-wins loader.
