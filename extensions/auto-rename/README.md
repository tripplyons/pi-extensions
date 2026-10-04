# Auto-rename

Names unnamed sessions after an agent turn using a separate request to the
selected model. Existing names are preserved. The request includes user and
assistant text from the active branch, capped at 60,000 characters, without tools.
The request disables cache retention so session-based providers, including the
Claude bridge, run it separately from the live agent session. Provider failures
produce a warning and leave the session unnamed.
