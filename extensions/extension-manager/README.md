# Extension manager

`/extensions` opens a searchable menu of installed personal extensions. Enter or
Space toggles the selected extension between enabled and disabled. Extensions
are enabled unless you disable them here or with `pi config`.

Changes are written to `~/.pi/agent/settings.json` (`PI_CODING_AGENT_DIR`
overrides this) with the same filters as `pi config`. A disabled package
extension adds `-path` to that package's `extensions` filter. A disabled
top-level extension adds `-path` to the top-level `extensions` list. Enabling it
again removes the entry. Pi reloads when the menu closes if anything changed.

The menu lists personal extensions only. Project extensions, built-in
extensions, and this extension are not listed. Use `pi config` for those.
Outside the TUI, the command points to `pi config`.
