# Codex compaction (in progress)

This module implements the wire rules of Stack's `remote_compaction_v2` policy:
paired tool calls, recent user text retention within 256 KB, the compaction
trigger, beta/version/routing headers, Astra overrides, and strict opaque
checkpoint validation. It does not substitute a generated text summary.

The protocol helpers have synthetic regression coverage. Transport, cancellation,
model/session-bound persistence, payload projection, and threshold integration
are not connected yet. This directory is deliberately absent from Pi's extension
manifest until those paths are implemented and tested. No live request is made by
these tests.
