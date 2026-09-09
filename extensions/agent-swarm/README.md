# Agent swarm

`agent-swarm` runs a durable hierarchy of Pi workers in tmux. It requires Codex Code mode, macOS `sandbox-exec`, tmux, Git, Node, and a stored Pi credential for the selected model's provider. Other platforms refuse worker launch.

Workers snapshot the coordinator session's current `/fast` setting when they are spawned and use the same Codex service tier without changing the active swarm system prompt.

## Security boundary

Every worker runs under `/usr/bin/sandbox-exec` in a linked Git worktree. File reads are unrestricted. A worker can read every file available to the host user, including credentials, other repositories, the coordinator checkout, sibling worktrees, and swarm control state.

File writes use a denylist. Workers may write any host-user-writable location except the coordinator checkout, shared Git metadata, swarm authority and sibling state, common credential locations, and system or application paths. The worker's own worktree, private home, temporary directory, and request outbox are exceptions within the protected swarm state root. Reviewers cannot write their worktrees. Workers can still modify other repositories, documents, user configuration, and installed tools not covered by the denylist.

The worker receives a private copy of the Pi files required for Codex authentication, but unrestricted reads also expose the original credential file, SSH and cloud credentials, user extensions, skills, and other host files. User web and ask tools are not loaded. Outbound network access is required for model calls. The macOS sandbox cannot restrict that access to an inference host, so a worker can transmit any readable data. Use a managed sandbox with host-side credential injection for a stronger boundary. This version fails closed outside macOS and has no external launcher backend.

Linked worktrees share Git history, object storage, and repository configuration. The write denylist protects that shared metadata. Do not put credentials in repository remotes or local Git configuration because workers can read them.

Git LFS, custom content filters, and custom merge drivers are unsupported. Controller Git operations reject active filters before processing worktree content. Integration rejects custom merge attributes before merging. Controller subprocesses also disable configured filter and merge-driver commands in case attributes change after preflight. Built-in text, binary, and union merge behavior remains available. Hooks, fsmonitor hooks, signing, external diff, and textconv are disabled.

Stop, pause, and timeout operate on the original worker process group. A descendant that detaches into another session can survive stop or timeout and keep running during pause. The sandbox still applies to that descendant. The supervisor does not provide complete process containment.

## Roles

- The coordinator is the user's root session. It sees the full tree and may stop any descendant.
- A manager may spawn, instruct, review, restart, stop, and integrate direct children.
- A worker edits its assignment and submits it to its direct parent.
- A reviewer gets a read-only snapshot of a direct child's result commit and reports findings to their shared parent.

Only direct parents issue instructions or review results. Only generated manager branches accept swarm integration. The coordinator reports accepted branches for human integration and never merges them.

Defaults limit a run to depth 2, four active children per coordinator or manager, eight active nodes, and 30 minutes per worker. Awaiting-review nodes consume capacity. Configure these values in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/agent-swarm.json` before starting a run:

```json
{
  "maxDepth": 2,
  "maxActiveChildren": 4,
  "maxActiveNodes": 8,
  "startupTimeoutMs": 30000,
  "workerTimeoutMs": 1800000,
  "pollIntervalMs": 250,
  "maxInlineBytes": 65536,
  "protectedBranches": ["main", "master"],
  "allowedRoles": ["manager", "worker", "reviewer"],
  "roleThinking": { "reviewer": "high" }
}
```

Workers inherit their parent's model and thinking level. Optional `roleModels` and `roleThinking` maps override this per role. Model overrides use `provider/model` names. Workers cannot change the run's configuration.

## Commands

- `/swarm:start <objective>` activates the current session as coordinator.
- `/swarm:status` shows the hierarchy.
- `/swarm:tree` opens a parent-first nested hierarchy with live node details and tmux output. Use arrows or `j`/`k` to select, brackets to scroll details, and Escape to close.
- `/swarm:pause` freezes worker process groups.
- `/swarm:resume [runId]` reconnects and resumes workers.
- `/swarm:kill` stops workers but keeps state and worktrees.
- `/swarm:runs` lists retained runs for reconnection.
- `/swarm:clear` removes clean worktrees, worker credentials, sessions, mailboxes, and audit records. It retains generated branches and a cleared-run marker with the ownership lock inode.
- `/swarm:help` summarizes commands and limits.

## Code tools

```js
const manager = await tools.swarm_spawn({
  role: "manager",
  task: "Implement the parser change. Delegate implementation and review, then combine accepted work."
});
text(manager);
```

- `swarm_task` reads the durable task and inbox. Its first successful read returns the complete view; subsequent reads in that extension session return only changed run, node, and message state. Pass `full: true` to return a complete view and reset the delta baseline, `requestId` to inspect a pending operation, or `acknowledge` with message IDs after reading them.
- `swarm_spawn` creates a direct child. `includeDirty: true` copies a dirty parent snapshot without changing the parent. Reviewer assignments require `reviewTargetId` for a direct child awaiting review.
- `swarm_send`, `swarm_tree`, and `swarm_observe` provide direct-edge messages and scoped observation. Only the root can capture tmux output.
- `swarm_complete` submits text and optional verification. The controller commits implementation changes on the node's generated branch.
- `swarm_review` accepts, rejects, or requests changes. `swarm_integrate` is a separate manager-only operation.
- `swarm_stop`, `swarm_restart`, and `swarm_cleanup` manage direct children. The root may emergency-stop descendants.
- `swarm_kill` and `swarm_clear` are root-only run operations.

Large task, message, result, feedback, and verification strings use private request artifacts, capped at 10 MiB each. Tool previews point to full output files. Recipient snapshots expose only that recipient's artifact copies.

## Recovery and storage

State lives under `PI_SWARM_HOME`, or `${XDG_STATE_HOME:-~/.local/state}/pi/agent-swarm`. It must be outside the repository. Each run has root-owned records and per-node private mailboxes, homes, temporary files, and linked worktrees.

The root takes a kernel-backed exclusive lock. Reopening its session reconnects the run. `/swarm:resume <runId>` reconnects from another session. Workers retain queued requests while the controller is absent. Completed requests replay their stored response. An interrupted side effect receives an indeterminate-operation error instead of running again. Inspect state before issuing a new operation.

Closing the root releases ownership but does not kill workers. Supervisors continue enforcing active-time limits on their original process groups. Paused groups remain paused until a root resumes them. Failed or stopped workers restart explicitly; restart rotates their capability.

Cleanup refuses dirty worktrees. Clear checks every retained worktree before stopping anything, then checks again after stopping the groups. Generated branches remain for human recovery. A cleared-run marker preserves the lock inode and prevents reconnection to deleted run data.

The macOS policy explicitly denies sibling process inspection, including raw process-argument syscalls. DNS uses the system mDNSResponder socket; arbitrary host Unix sockets are denied. File write denials cover the current checkout and known credential locations, not all valuable host files. These restrictions do not provide CPU, disk, or inference-spending quotas. The extension and coordinator still run with the user's permissions.

Use `subagent` for a one-shot, session-scoped child. New subagents are disabled while a session is attached to an active or paused swarm because they bypass swarm limits and isolation. `subagent_process` remains available for jobs started before activation.
