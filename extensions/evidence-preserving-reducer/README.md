# Evidence-preserving reducer

Replaces long build and test logs with short receipts that quote only the lines
that matter, and checks every quote against the original log.

It applies to Bash results, and to `then_run` output from
[Action Fusion](../action-fusion), when all of these hold:

- The command looks like a build or test run, such as `npm test`, `bun test`,
  `cargo test`, `pytest`, `go test`, `make`, or `lake build`.
- The output is at least 4 KiB and at most 600,000 characters.
- The output does not look like it contains a secret.

The full log is archived beside the session file in
`evidence-preserving-reducer/<session id>/objects/`. When Bash truncated the
output, the archive holds Bash's full output file. GPT 6 Luna then reads the
log and returns up to 12 exact quotes, each tagged `fatal`, `failure`,
`warning`, `target`, or `summary`.

The receipt is used only if every check passes:

- Each quote appears byte for byte in the log.
- The status matches the tool result.
- A failing log with failure text has at least one `fatal` or `failure` quote.
- The receipt is smaller than the log.

Otherwise the original output reaches the agent unchanged. The receipt names
the archive path, so the agent can read exact context with Bash. It does not
diagnose failures or suggest fixes.

Each decision is recorded as an `evidence-preserving-reducer` session entry,
which stays out of model context. Without a configured GPT 6 Luna model, logs
pass through unchanged. Reduction costs one Luna request per qualifying log.

Adapted from [SoL-Pi](https://github.com/NVlabs/SoL-Pi) Evidence-Preserving
Reducer. See `licenses/sol-pi.txt` for the MIT license.
