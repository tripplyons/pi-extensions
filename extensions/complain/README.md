# Complain

The `complain` tool records problems that an agent encounters with its environment or tools. Reports stay on the local machine as plaintext JSONL:

```text
${XDG_STATE_HOME:-~/.local/state}/pi/complain/complaints.jsonl
```

Use it proactively when a reproducible infrastructure, sandbox, or tool-harness failure
repeats and materially impedes the work. Include what failed, how to reproduce it, and
its impact. Do not report ordinary task or code errors, expected validation failures, or
an isolated transient failure.

Each line contains:

- `timestamp`, as an ISO 8601 UTC value
- `message`, supplied by the agent
- `toolCallId`
- `session.id` and the nullable `session.path`
- `cwd`
- `model.provider` and `model.id`, or `null` when no model is selected
- `thinkingLevel`

The tool accepts one required field:

```json
{
  "message": "The shell tool discarded stderr when the command timed out."
}
```

Review recent reports:

```sh
tail -n 20 "${XDG_STATE_HOME:-$HOME/.local/state}/pi/complain/complaints.jsonl"
```

Filter them with `jq`:

```sh
jq -s 'sort_by(.timestamp) | reverse | .[] | {timestamp, message, session, cwd}' \
  "${XDG_STATE_HOME:-$HOME/.local/state}/pi/complain/complaints.jsonl"
```

The extension flushes each appended report to disk before it reports success. It does not send reports anywhere or remove old entries. Complaint messages may contain sensitive data, so protect or rotate the file as needed.

Agent-swarm explicitly loads this extension in spawned managers, workers, and reviewers. It sets `PI_COMPLAIN_LOG` to the coordinator's log path, so their reports survive worker cleanup and appear beside coordinator reports. `PI_COMPLAIN_LOG`, when set by a controller, must be absolute.
