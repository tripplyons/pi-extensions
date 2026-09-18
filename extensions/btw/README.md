# BTW

- `/btw <question>` asks a side question without tools.
- `/btw:tools <question>` allows the active tools in the side conversation.

Each request copies the saved session into a temporary session and runs
Pi with the selected model and reasoning level. Replies appear inline but are excluded from the main model context. Child processes
are stopped on session shutdown, and temporary sessions are removed afterward.

Requires `pi` on PATH. Tool-enabled questions can modify files just like the main
session; they do not run in an isolated worktree.
