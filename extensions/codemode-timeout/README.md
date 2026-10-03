# Codemode timeout

Caps codemode's `timeout_ms` at 300,000 ms (five minutes) before execution.
Scripts without a timeout get the same deadline. Shorter deadlines and other
options stay unchanged. Pi still validates malformed input.

This extension uses the `tool_call` hook. It does not replace codemode or limit
background tasks started by nested tools. No configuration is required.
