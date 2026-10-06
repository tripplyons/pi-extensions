# Presentation

Requires Pi 1.0.1 or newer. Hides the working indicator and shows one content
row per collapsed tool call. Each group starts with one blank separator, with
no blank lines between calls in the group. Visible user messages and assistant
prose start a new group; empty messages and hidden thinking do not. The row
contains the tool name, key argument, and a short result or execution status.
While the model writes a tool call, the row shows the newest argument text and
`writing N chars`, where N counts characters in the argument values. The count
and text update as Pi supplies partial arguments. If a provider emits raw JSON
chunks but leaves its parsed arguments empty, the presentation extension recovers
partial arguments for display only. It does not change messages or execution input.
Recovery keeps at most 1,048,576 JSON characters per call, then uses the provider's
parsed arguments. The cache clears when the message ends or the session resets.
Long arguments show their end instead of a fixed prefix. Expand the call to see
its full input through the original renderer. Providers that emit no argument
chunks cannot show the input before completion.

After generation, the row changes to `pending`, then `running` when execution
starts. Partial results show the latest nonempty output line. Codemode shows the
active nested tool and completed-call count even when its partial text is empty.
Completed results return to the compact summary. Long previews truncate to the
terminal width instead of wrapping. Errors stay on one row and use the theme's
error color.

A `registerToolRenderer()` resolver covers native, extension, MCP, and unknown
tools, including tools loaded after the session resumes. It changes rendering
only, not schemas, execution, results, exposure, or tool selection. Expansion
uses the original tool renderers when available, preserving edit diffs and
specialized output. Other expanded results use readable text. Inline images
appear only when expanded and Pi's image setting allows them.

Tool names use the theme's accent color. Bash uses an accent-colored `$` prefix.
Arguments use the normal foreground color, and summaries use muted text. The
selected Pi theme controls colors. Multiline commands collapse to one row and
retain their lines when expanded.

Pi appends images outside tool renderers and has no public user-message spacing
hook. Small tested component adapters suppress collapsed images, remove vertical
padding from default tool shells and separators between adjacent tool calls,
keep mouse targets aligned, and restore the original renderers on shutdown.
Hidden thinking blocks omit the `Thinking...` placeholder and its spacing.
Visible thinking remains unchanged; Pi's `hideThinkingBlock` setting controls
visibility. Messages and thinking content stay unchanged in session history.
User messages retain prompt-zone markers and have no background-only rows above
or below their content. Spacing within expanded output stays unchanged.

The one-line footer shows folder, model, reasoning, native context-window use,
branch-local estimated cost, and extension statuses. Both Council variants omit
the reasoning field because their presets fix effort. The footer reserves room for the background
compaction state before shortening the other fields. It uses
`ctx.getContextUsage()`. For example, `25%/272k` means the current context uses
25% of a 272,000-token model window, not the old `/threshold` budget. Pi may not
know usage just after compaction; that shows `?%/272k` until usage becomes
available. Cost is a catalog estimate, not an invoice; ChatGPT subscription use
does not imply API billing.
