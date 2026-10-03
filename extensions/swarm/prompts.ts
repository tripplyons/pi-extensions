import { reviews } from "./coordination.ts";
import { currentAssignment, handoffRecord, terminal, type Run, type Node } from "./state.ts";

export const workerStart = "Read your durable assignment with swarm_task, then carry out only that bounded step. You are a swarm worker. Ask your parent instead of prompting the user. Submit a self-contained handoff with swarm_complete, called alone. Never integrate worker branches into the parent's branch or push. Sync a base branch into your own branch only when instructed.";

export function coordinationGuidelines(node: Node, run?: Run): string[] {
  const common = [
    "Swarm assignments are durable, but workers do not inherit the parent's conversation. State scope, owned files, dependencies, acceptance checks, resource limits, and commit permission in each assignment. Prefer one bounded step per worker; list follow-on work in the handoff rather than starting it.",
    "Coordinate shared files and APIs before editing. Siblings may exchange informational swarm_send messages, but only a parent may give instructions. Do not edit a sibling's or parent's worktree. Report a dependency blocker to the parent with the exact API or commit needed; do not poll or invent a substitute.",
    "Swarm tools do not merge branches. Only the parent integrates submitted work into its branch. A worker may sync an explicitly approved base into its own branch. Pin the tested base; do not repeat full checks just because an unrelated base update arrives after testing. The parent verifies the integrated result.",
  ];
  const pending = run ? [`Pending parent reviews, oldest first: ${reviews(run, node.id).map(child => `${child.name} (${child.nodeId}, revision ${child.revision}, waiting ${child.waitingSeconds ?? "unknown"} seconds)`).join(", ") || "none"}. Use swarm_reviews to inspect and decide on direct-child handoffs.`] : [];
  if (!node.parent) return [...common, ...pending,
    "Read each pending handoff and record a decision before assigning follow-on work. Do not treat the active count as proof that workers are working.",
    "Use swarm_tree for compact active-worker summaries and swarm_tree with nodeId for a full assignment or handoff. Use swarm_broadcast for shared instructions to your nonterminal direct children. Set permission=released when authorizing work after a wait; ordinary messages do not authorize work. Use swarm_reload to request checkpoints, restart after every checkpoint, wait for matching-version readiness, then explicitly release with bounded assignments. Review the diff and reported checks before accepting; acceptance stops the worker but does not integrate its branch. Record per-revision source review, tests and integration evidence with swarm_record. Use swarm_replace action=request to ask for a wrap-up, then accept the handoff before action=start with an explicit testedBase and target model. Request changes for a bounded fix, not a follow-on assignment.",
    "Limit concurrent expensive jobs to the project's resource budget. Inspect stalled workers with swarm_observe, then steer or stop them. When winding down, broadcast that workers must finish only their assigned step and submit; do not spawn replacements.",
  ];
  return [...common, ...pending,
    `Permission to proceed: ${node.permission?.status ?? "unknown"}. This is separate from recent activity. A check-in or tool event cannot release a wait. ${node.permission?.status === "checkpoint-hold" ? `Reload stage ${node.reload?.stage ?? "unknown"}: finish only the existing bounded step while checkpoint is requested; then call swarm_reload action=checkpoint with recovery details and wait. After restart, do not edit or launch jobs until the parent explicitly releases the barrier.` : "When waiting for approval or a dependency, ask the parent for a released permission with a bounded assignment before resuming work."}`,
    "Read swarm_task on start or recovery. currentAssignment contains the current parent directive or original unfinished task. historicalHandoff and node.feedback are historical, not a new assignment. If currentAssignment is null, report waiting-instructions to your parent and wait without edits or jobs. Report activity with swarm_send(activity=working|waiting-instructions|waiting-dependency) when starting work or entering a wait. Follow current parent instructions. Ask the parent with swarm_send when scope, ownership, or required evidence is unclear; never prompt the user directly.",
    "Finish only your assigned step, run the required checks, and submit with swarm_complete alone. Do not start a next step or continue tools while awaiting review. Commit only when authorized. A no-change finding is a valid result when supported by measurements or evidence.",
    "Your swarm_complete handoff must stand alone: outcome and scope; branch, tested base and authorized commits (or no commit); changed files; exact check commands and results; evidence for important claims; known limitations, unverified behavior and blockers; and ordered next steps with exact file paths and APIs. Distinguish completed support from gated or incomplete work. Keep essential details in the result, not only in temporary files.",
  ];
}

export function handoffStatus(node: Node) {
  return handoffRecord(node)?.status ?? "none";
}

const summary = (text: string) => text.length > 240 ? `${text.slice(0, 240)}…` : text;
function assignmentSummary(node: Node) {
  const assignment = currentAssignment(node);
  return assignment ? { ...assignment, text: summary(assignment.text) } : null;
}
export function treeSnapshot(run: Run, includeTerminal = false, model?: string, now = Date.now()) {
  const nodes = Object.values(run.nodes);
  return {
    objective: run.objective,
    reviewQueue: reviews(run, run.root, now), barriers: Object.values(run.barriers ?? {}),
    active: nodes.filter(node => node.id !== run.root && !terminal(node.status)).length,
    finished: nodes.filter(node => terminal(node.status)).length,
    nodes: nodes.filter(node => (includeTerminal || !terminal(node.status)) && (!model || (node.current?.model ?? node.launch?.model) === model)).map(node => ({
      id: node.id, parent: node.parent, name: node.name, depth: node.depth, status: node.status,
      branch: node.branch, cwd: node.worktree?.cwd, started: node.started,
      launch: node.launch, current: node.current, effectiveModel: node.current?.model ?? node.launch?.model,
      modelSource: node.current ? "session" : node.launch?.model ? "launch" : "unknown",
      runtime: node.runtime, versionState: !node.runtime || !run.nodes[run.root].runtime ? "unknown" : node.runtime.revision === run.nodes[run.root].runtime!.revision ? "matches-root" : "differs-from-root",
      permission: node.permission ?? null, reload: node.reload,
      handoff: handoffStatus(node), handoffRevision: handoffRecord(node)?.revision, resume: node.resume,
      currentAssignment: assignmentSummary(node), activity: node.activity ? { ...node.activity, detail: summary(node.activity.detail) } : null,
      code: { source: "parent-reported", records: node.delivery?.map(record => ({ revision: record.revision, reviewed: !!record.reviewed, tested: !!record.tested, integrated: !!record.integrated })) ?? [],
        coverage: "Only listed revisions have evidence; other work is unrecorded. Handoff acceptance does not review, test or integrate code." },
      replacement: node.replacement, predecessor: node.predecessor,
      task: summary(node.task),
      hasResult: node.result !== undefined,
    })),
  };
}
