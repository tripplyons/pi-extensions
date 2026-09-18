# File tools

Replaces Pi's read tool with Stack-style byte-range reads. Disables the built-in
`write` and `edit` tools; use shell commands to change files. Adds `list`, literal `search`, and
`view_image`. Relative paths resolve against the session cwd; absolute paths and
paths outside the workspace are allowed, subject to OS permissions.

Reads reject NUL bytes and malformed UTF-8, including split character boundaries.
Lists do not recurse through symlinks. Searches follow only links within the requested
root, avoid cycles, skip binary and over-1-MiB files, and report truncation and
skipped counts. Images return native image blocks for PNG/JPEG/GIF/WebP up to
20 MiB; model support for animation varies.

Tool results display as plain-text previews instead of JSON. Expand a result to
see all fields and output; structured result data is unchanged.

Read previews show the file path and byte offset/limit in the normal foreground
color, with the tool name in accent. The range is in bytes, not lines.
