# File tools

Replaces Pi's read/write/edit tools with Stack-style byte-range reads, atomic
UTF-8 writes and exact unique edits. Adds `list`, literal `search`, and
`view_image`. Relative paths resolve against the session cwd; absolute paths and
paths outside the workspace are allowed, subject to OS permissions.

Reads reject NUL bytes and malformed UTF-8, including split character boundaries.
Writes create missing parent directories and follow existing symlinks. Lists do
not recurse through symlinks. Searches follow only links within the requested
root, avoid cycles, skip binary and over-1-MiB files, and report truncation and
skipped counts. Images return native image blocks for PNG/JPEG/GIF/WebP up to
20 MiB; model support for animation varies.
