# Skills

Adds prompt instructions to read SKILL.md before use, follow activation conditions,
and resolve references against the skill directory.

The instructions go into `appendSystemPrompt`, after any `--append-system-prompt`
text. Pi-native providers and the Claude Agent SDK bridge both send that field;
the bridge drops custom prompt sections.

Pi owns skill discovery, parsing, diagnostics, deduplication, commands, and
completion. Its native locations include project and global Pi skills and shared
`.agents/skills` directories. This extension adds no discovery paths and does not
load Stack Agent skill directories.
