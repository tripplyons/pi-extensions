# ObservationPack

Keeps large tool results from riding along in every later provider request.

A successful text-only tool result over 10 KiB is sent in full for two provider
requests. After that, the request carries a placeholder instead: the result's
size, the first and last 512 bytes of whole lines, and an observation ID. The
agent can read the full text again with `obs_recall`:

```json
{ "id": "obs_0123456789abcdef01234567", "offset": 0 }
```

Each page holds up to about 16 KiB or 398 lines and reports `next_offset`.

Only the provider request changes. The session file keeps every result, so
`/tree`, export, and compaction see the original text. Error results, results
with images, and [evidence receipts](../evidence-preserving-reducer) are never
replaced. If a result cannot be stored, it stays in full.

Stored results live beside the session file in
`observation-pack/<session id>/objects/`, with private file permissions.
In-memory sessions use a private temporary directory.

Adapted from [SoL-Pi](https://github.com/NVlabs/SoL-Pi) ObservationPack. See
`licenses/sol-pi.txt` for the MIT license.
