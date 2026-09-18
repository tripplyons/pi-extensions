# Ask user

`ask_user({question, choices})` asks for free text; choices are suggestions, not
forced selections. Suggestions appear as a numbered list beneath the question. Escape, cancellation, and the ten-minute timeout fail without
inventing an answer. Requires interactive Pi (or a compatible RPC UI). Swarm
workers ask their parent instead. Questions must not request secrets.

Answers are returned as plain text, not JSON. Structured results retain
`details.answer`.

The tool preview shows `ask_user` in accent followed by the streamed question in
the normal foreground color.
