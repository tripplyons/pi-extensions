# Presentation

Hides the working indicator. Compact tool display and a one-line footer: folder, model,
reasoning, last input/output usage, branch-local API cost, and extension statuses
(goal/pruner/fast). Counts include cached input. Uses the selected Pi theme and
clips safely to terminal width. The tool expansion shortcut still works.

Pi controls message layout and its collapsed-tool line count; exact Stack
five-line previews require custom tool renderers (parity audit pending).

The built-in Working row is hidden entirely, including its label and animation.

User messages have no background-only rows above or below their content. Pi has
no native user-message renderer hook, so this overrides the exported component
renderer and restores it on shutdown. Terminal prompt-zone markers are retained.
