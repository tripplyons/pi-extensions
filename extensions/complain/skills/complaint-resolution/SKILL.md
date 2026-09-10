---
name: complaint-resolution
description: Investigate and resolve records from the local Pi complaint log. Use when asked to handle, resolve, audit, or clean complaints recorded by the complain tool.
---

# Complaint resolution

Resolve complaints from evidence. Do not treat deleting a record as resolving it.

## Workflow

1. Resolve the log path exactly as the `complain` extension does:
   - Use absolute `PI_COMPLAIN_LOG` when set.
   - Otherwise use `${XDG_STATE_HOME:-$HOME/.local/state}/pi/complain/complaints.jsonl`.
2. Read and parse every JSONL record. Preserve the original bytes until the audit is complete.
3. For each record:
   - Inspect its session path, cwd, timestamp, tool call ID, and message.
   - Reproduce the reported failure when doing so is safe.
   - Trace it to the root cause. Do not hide it with a guard that only suppresses the symptom.
   - Fix the root cause or perform the explicitly authorized cleanup.
   - Prove the real failing operation now works. Record the exact verification in the final report.
4. Classify the record:
   - **Resolved:** direct evidence proves the complaint is fixed.
   - **Still open:** the failure remains, verification is missing, or required destructive action lacks authorization.
5. Rewrite the log only after classification:
   - Remove only resolved records.
   - Preserve each open record byte-for-byte and in its original order.
   - Before replacing the file, reread it and retain any records appended during the investigation.
   - Write a sibling temporary file, flush it, set mode `0600`, then atomically rename it over the log.
6. Reread the final log. Confirm it is valid JSONL, contains every open or newly appended record, and has mode `0600`.

If no records remain, keep an empty `0600` log file. Report resolved and remaining counts separately.

Never remove a complaint merely because it is old, inconvenient, unreproducible, or outside the current repository.
