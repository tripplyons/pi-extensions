# Presentation

Hides the working indicator and keeps compact tool rows. The one-line footer
shows folder, model, reasoning, native context-window use, branch-local estimated
cost, and extension statuses. The selected Pi theme controls colors.

Read, edit, write, grep, find, and ls use Pi's public tool factories. Only their
call titles change; schemas, execution, images, truncation, and results remain
native. The tool expansion shortcut still works.

Tool calls keep one blank separator with no vertical shell padding. Custom
self-rendered shells and spacing within output stay unchanged. Pi has no public
tool-shell or user-message spacing hook, so these small component adapters
restore the original renderers on shutdown. User messages retain prompt-zone
markers and have no background-only rows above or below their content.

The footer uses `ctx.getContextUsage()`. For example, `25%/272k` means the
current context uses 25% of a 272,000-token model window, not the old
`/threshold` budget. Pi may not know usage just after compaction; that shows
`?%/272k` until usage becomes available. Cost is a catalog estimate, not an
invoice; ChatGPT subscription use does not imply API billing.
