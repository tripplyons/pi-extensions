# Hide empty editor

Hides the input box when its text is empty. Typing or restoring text brings it
back. Whitespace counts as text. Keyboard shortcuts still work while hidden.

Restored from the original hide-empty-editor extension. Wraps an existing editor
when one is registered, otherwise uses Pi's default custom editor. Runs only in
interactive TUI mode.

Horizontal borders and their rows are removed. Input uses `userMessageBg`,
which the dotfiles Pi theme maps to `weak_background`. Completion menus keep
their own styling. Mouse coordinates are translated to the compact layout.
