# Ask user

`ask_user({question, choices})` asks for free text; choices are suggestions, not
forced selections. Escape, cancellation, and the ten-minute timeout fail without
inventing an answer. Requires interactive Pi (or a compatible RPC UI). Swarm
workers ask their parent instead. Questions must not request secrets.
