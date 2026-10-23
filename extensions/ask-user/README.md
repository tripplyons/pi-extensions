# Ask user

`ask_user({question, choices})` asks one question. With choices, the user picks
from a select list whose last entry, "Other (type an answer)", opens free-text
input. Without choices, free-text input opens directly. Escape at either step,
cancellation, and the ten-minute timeout fail without inventing an answer.
Requires interactive Pi (or a compatible RPC UI). Swarm workers ask their parent
instead. Questions must not request secrets.

## Scrolling and controls

In Pi's terminal UI, questions open in a size-limited overlay. Page Up and Page
Down scroll the question without changing the selected choice or typed answer.
The mouse wheel also scrolls the question in fullscreen mode. A line-range hint
appears when the terminal has room for it.

Use Up/Down or `j`/`k` to select a choice, Enter to answer, and Escape to cancel.
Choice labels wrap, and the choice list follows the selection. The selected
choice or free-text input stays visible as the question scrolls or the terminal
resizes. On terminals with only one row, the answer control takes priority.

RPC clients keep the native select/input requests. Scrolling in those dialogs
is controlled by the client, not this extension.

## Returned answers

Answers are returned as plain text, not JSON. A picked choice returns its full
text, so the agent never has to interpret a number. Structured results retain
`details.answer`, plus `details.choice` (1-based) for a picked choice.

The tool preview shows `ask_user` in accent followed by the streamed question in
the normal foreground color.
