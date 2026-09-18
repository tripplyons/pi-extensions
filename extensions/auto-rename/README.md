# Auto-rename

Names unnamed sessions after an agent turn using a separate request to the
selected model. Existing names are preserved. The request includes user and
assistant text from the active branch, capped at 60,000 characters, without tools.
Provider failures produce a warning and leave the session unnamed.
