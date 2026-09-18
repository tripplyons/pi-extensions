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
