# Context pruner

Automatic pruning is off initially. `/pruner [on|off]` toggles it. `/prune` queues
a manual pass on the next request. Pruning changes only the outgoing projection,
never the source messages in Pi's session file.

With [Jev policy](../jev-policy) enabled (the default), older eligible tool
interactions trigger automatic pruning at 100 KB or more. Jev scores their
importance for the current task and trims them to a 50 KB retention budget. Keep the highest-scoring interactions that fit;
archive the rest. Equal scores favor newer interactions. There is no score cutoff.
The budget counts serialized tool calls and text output, not tokens.

The five newest eligible interactions always stay, outside that budget. Skill
reads, archive retrievals, unfinished calls, reasoning, images, oversized
interactions, and checkpoint-covered calls also stay outside it. The whole context
can therefore exceed 50 KB. Existing archives are not automatically restored.

Each scoring batch contains up to eight interactions and 16 KB of full candidate
data, plus up to 32 nonempty user/assistant and readable compaction/branch summary
excerpts using the remaining 28 KB input budget. The latest user request and
summaries get priority; tool-only messages do not crowd out conversation. Opaque
Codex checkpoints are not sent. All batches are scored before anything is
archived, within the same model request. A failed or invalid decision retains the
entire pool; the next request can retry. This can add several decision calls to a
request with a large backlog. Later requests rescore the remaining pool when it
reaches 100 KB again. A manual pass uses the same budget, even with automatic
pruning off; it does not empty a pool that already fits.

The Jev footer shows retained older eligible bytes against the 100 KB trigger, excluding the
newest five and protected content. Between passes it can exceed 50 KB; successful pruning brings it back to 50 KB
or less. Failed scoring retains the pool for a later retry.

`tool_pruner_view({ids:["tp_1"]})` retrieves the original call and result. Archives
and preferences persist on the active session branch.

`/jev off` restores deterministic pruning: once 50 KB is reclaimable, archive all
eligible older large results and shell/write/edit arguments, preserving the newest
five eligible interactions. Manual passes bypass that trigger. Old reasoning can
also be removed. The footer then shows reclaimable bytes and resets to `0.0/50 KB`
after a pass. Removed reasoning stays removed on later requests and session reloads.

Tool results display as plain-text previews instead of JSON. Expand a result to
see all fields and output; structured result data is unchanged.
