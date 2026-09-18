# Codex compaction (in progress)

This module implements the wire rules of Stack's `remote_compaction_v2` policy:
paired tool calls, recent user text retention within 256 KB, the compaction
trigger, beta/version/routing headers, Astra overrides, and strict opaque
checkpoint validation. It does not substitute a generated text summary.

The protocol and HTTP transport have synthetic and local-server regression
coverage, including split SSE frames, cancellation, and invalid responses.
Checkpoint serialization and exact-prefix projection are tested, including
model/session binding and edited-history rejection. Session lifecycle hooks and
automatic threshold integration are not connected yet. This directory is deliberately absent from Pi's extension
manifest until those paths are implemented and tested. No live request is made by
these tests.
