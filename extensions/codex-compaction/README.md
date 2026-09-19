# Codex compaction

Uses Codex `remote_compaction_v2` rather than summary text. Automatically compacts
before the next request after 60,000 input/output/cache tokens. `/threshold [60k]`
shows or changes that boundary. `/codex-compact` queues a manual pass. Pi's native
summary compaction is intercepted for Codex only and queues the same operation.
Other providers retain Pi's normal compaction.

Opaque checkpoints and thresholds persist on the active session branch. Exact
prefix hashes, model identity, and session identity guard checkpoint reuse.
Original history is retained. Failures explicitly abort the outgoing request;
cancellation, session navigation, and model selection cancel pending transport.

Protocol, transport, projection, and event hooks have synthetic regression tests.
Live Codex interoperability and real provider abort behavior remain unverified.

New checkpoints record covered tool call IDs so Jev pruning can retain that
prefix. Existing checkpoints without this metadata prevent new Jev pruning until
replaced. This does not change compaction timing or thresholds.
