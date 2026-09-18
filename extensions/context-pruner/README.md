# Context pruner

Automatic pruning is off initially. `/pruner [on|off]` toggles it. `/prune` queues
a manual pass on the next request. Keep the five newest eligible interactions;
automatic passes require 100 KB reclaimable. Archive large tool results and large
shell/write/edit arguments. Protect skill reads, archive retrievals, unfinished
calls, and reasoning for retained calls. Old reasoning can be removed.

`tool_pruner_view({ids:["tp_1"]})` retrieves the original call and result. Archives
and preferences persist on the active session branch. Pruning changes only the
outgoing projection, never the source messages in Pi's session file.

The footer shows bytes still reclaimable, not bytes already archived. It resets
to `0.0/100 KB` after a pass. Removed reasoning stays removed on later requests
and session reloads, while the original session history remains intact.
