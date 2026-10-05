# Python

Adds the `python` tool for inline Python source. Requires `uv` on `PATH` and this
package's [tasks extension](../tasks).

Every script must include a PEP 723 metadata block with `requires-python` and
`dependencies`. Use `[]` when the script needs only the standard library:

```python
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.28,<1"]
# ///

import httpx

response = httpx.get("https://example.com", timeout=20)
print(response.status_code)
```

Pass the complete source in `code`, without Markdown fences. Optional `args`
contains literal script arguments. `timeout` sets the background deadline in
seconds, including dependency installation and Python downloads. It defaults to
1800 seconds (30 minutes) and allows positive values up to 2147483.647 seconds.

The tool checks the required metadata fields. `uv` validates package requirements
and Python version constraints, resolves dependencies, and selects or downloads
a compatible Python. To select a minor version, use a constraint such as
`requires-python = ">=3.12,<3.13"`. A lower bound alone also allows newer versions.
No separate Python-version or dependency parameter overrides the script.

Scripts are saved with private permissions under
`~/.pi/agent/python/scripts/<uuid>.py`. `PI_CODING_AGENT_DIR` overrides the agent
directory. Scripts remain there after execution, including failed execution,
so the source remains available across reloads. A blocked or failed launch removes
the unused script. Saved source may contain sensitive data; do not embed secrets.
Delete saved scripts manually only after their tasks finish.

Execution delegates through Pi's nested-tool API to managed Bash with
`run_in_background: true`. The command uses `uv run --no-project --script` and
unbuffered Python output. The working directory remains the current project.
It does not create a project, requirements file, or project virtual environment.
`uv` keeps its own interpreter and dependency caches outside the repo by default.
The command inherits the local environment and uv settings.

The initial result contains `task_id` and `script_path`, not execution output or
proof of success. Use the existing task tools:

- `task_output` reads bounded output, up to 2,000 lines or 50 KB per read.
- `task_query` shows status and failure details.
- `task_stop` stops the process tree.
- `task_watch` enables progress reports, off by default.

Do not rerun a script because the initial result has no output. Completion
notifications, branch ownership, output cursors, deadlines, and stop behavior
come from the tasks extension. Tasks survive launching-turn cancellation and
Pi reloads. Quitting Pi stops them.

This tool is not a sandbox. Python code and dependencies have the same local
permissions as Bash, including file and network access. Nested Bash calls still
pass through tool hooks and permission checks. Missing uv, invalid requirements,
and script exceptions appear as failed tasks; inspect output before claiming
success.
