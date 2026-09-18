# Complaints

`complain({message})` writes a private JSON record with timestamp, session, cwd,
model, and thinking effort under `$XDG_STATE_HOME/pi-rework/complaints` (default
`~/.local/state/pi-rework/complaints`). `PI_REWORK_STATE_DIR` overrides the root.
Records concern the harness, not arbitrary project failures. No automatic upload.

Tool results display as plain-text previews instead of JSON. Expand a result to
see all fields and output; structured result data is unchanged.
