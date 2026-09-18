# Presentation

Hides the working indicator. Compact tool display and a one-line footer: folder, model,
reasoning, input usage as a percentage of the `/threshold` compaction limit, branch-local API cost, and extension statuses
(goal/pruner/fast). Counts include cached input. Uses the selected Pi theme and
clips safely to terminal width. The tool expansion shortcut still works.

Tool calls keep one blank separator line, with no vertical shell padding.
Custom self-rendered shells and spacing within tool output are unchanged. This
overrides Pi’s tool component renderer and restores it on shutdown.

The built-in Working row is hidden entirely, including its label and animation.

User messages have no background-only rows above or below their content. Pi has
no native user-message renderer hook, so this overrides the exported component
renderer and restores it on shutdown. Terminal prompt-zone markers are retained.

Context appears as `50%/100k` for 50,000 input tokens and a 100,000-token
compaction threshold. Cached input counts; output tokens do not. New sessions
show `0%/100k` until usage is reported. The display follows the active branch
and changes to `/threshold`; percentages can exceed 100%.
