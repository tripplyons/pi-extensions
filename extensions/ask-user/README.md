# Ask user

`ask_user({question, choices})` asks one question. With choices, the user picks
from a select list whose last entry, "Other (type an answer)", opens free-text
input. Without choices, free-text input opens directly. Escape at either step,
cancellation, and the ten-minute timeout fail without inventing an answer.
Requires interactive Pi (or a compatible RPC UI). Swarm workers ask their parent
instead. Questions must not request secrets.

Answers are returned as plain text, not JSON. A picked choice returns its full
text, so the agent never has to interpret a number. Structured results retain
`details.answer`, plus `details.choice` (1-based) for a picked choice.

The tool preview shows `ask_user` in accent followed by the streamed question in
the normal foreground color.
