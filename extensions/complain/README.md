# Complaints

`complain({message})` writes a private JSON record with timestamp, session, cwd,
model, and thinking effort under `~/.pi/agent/complaints`.
`PI_CODING_AGENT_DIR` overrides the agent directory.
Records concern the harness, not arbitrary project failures. No automatic upload.

Tool results display as plain-text previews instead of JSON. Expand a result to
see all fields and output; structured result data is unchanged.
