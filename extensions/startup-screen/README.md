# Startup screen

Replaces Pi's built-in header with a theme-colored `PI` wordmark and the current directory.

- Context lists omit user-wide context files.
- Skills and Extensions show only Pi's project scope, including project packages. User-wide and temporary CLI resources are hidden.
- Resource lists show project paths in both collapsed and expanded views. Empty sections, Prompts, and Themes are hidden. Diagnostics remain visible.
- Filtering only changes the display. Global resources and prompt templates remain loaded and usable.

The resource-section filter is adapted from Benjamin Davis's MIT-licensed [my-pi-setup](https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/ui-customization). See `LICENSE`.

This extension only changes TUI mode. It does not replace the footer, editor, or active theme.
