# Overseer

When `OVERSEER=1` or `ZMX_SESSION` is set, and both streams are terminals, emit
Overseer OSC 777 glow metadata: yellow while running, blue for questions and
completed turns, off after acknowledgement/shutdown. Never emits OSC in RPC or
piped output. Terminal input acknowledges completion without consuming the key.

Set `PI_OVERSEER_YELLOW` and `PI_OVERSEER_BLUE` to six-digit hex colors to match
the terminal theme. This ports Stack's overseer-status plugin; it does not invent
an additional session registry or change terminal multiplexer configuration.
