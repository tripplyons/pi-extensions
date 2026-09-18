# Complaints

`complain({message})` writes a private JSON record with timestamp, session, cwd,
model, and thinking effort under `$XDG_STATE_HOME/pi-rework/complaints` (default
`~/.local/state/pi-rework/complaints`). `PI_REWORK_STATE_DIR` overrides the root.
Records concern the harness, not arbitrary project failures. No automatic upload.
