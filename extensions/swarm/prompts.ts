import { terminal, type Run, type Node } from "./state.ts";

export const workerStart = "Read your durable assignment with swarm_task, then carry out only that bounded step. You are a swarm worker. Ask your parent instead of prompting the user. Submit a self-contained handoff with swarm_complete, called alone. Never integrate worker branches into the parent's branch or push. Sync a base branch into your own branch only when instructed.";

export function coordinationGuidelines(node: Node): string[] {
  const common = [
    "Swarm assignments are durable, but workers do not inherit the parent's conversation. State scope, owned files, dependencies, acceptance checks, resource limits, and commit permission in each assignment. Prefer one bounded step per worker; list follow-on work in the handoff rather than starting it.",
    "Coordinate shared files and APIs before editing. Siblings may exchange informational swarm_send messages, but only a parent may give instructions. Do not edit a sibling's or parent's worktree. Report a dependency blocker to the parent with the exact API or commit needed; do not poll or invent a substitute.",
    "Swarm tools do not merge branches. Only the parent integrates submitted work into its branch. A worker may sync an explicitly approved base into its own branch. Pin the tested base; do not repeat full checks just because an unrelated base update arrives after testing. The parent verifies the integrated result.",
  ];
  if (!node.parent) return [...common,
    "Use swarm_tree for compact active-worker summaries and swarm_tree with nodeId for a full assignment or handoff. Use swarm_broadcast for shared instructions to your nonterminal direct children. Review the diff and reported checks before accepting; acceptance stops the worker but does not integrate its branch. Request changes for a bounded fix, not a follow-on assignment.",
    "Limit concurrent expensive jobs to the project's resource budget. Inspect stalled workers with swarm_observe, then steer or stop them. When winding down, broadcast that workers must finish only their assigned step and submit; do not spawn replacements.",
  ];
  return [...common,
    "Read swarm_task on start or recovery for your assignment, parent ID, workspace, and sibling IDs. Follow current parent instructions. Ask the parent with swarm_send when scope, ownership, or required evidence is unclear; never prompt the user directly.",
    "Finish only your assigned step, run the required checks, and submit with swarm_complete alone. Do not start a next step or continue tools while awaiting review. Commit only when authorized. A no-change finding is a valid result when supported by measurements or evidence.",
    "Your swarm_complete handoff must stand alone: outcome and scope; branch, tested base and authorized commits (or no commit); changed files; exact check commands and results; evidence for important claims; known limitations, unverified behavior and blockers; and ordered next steps with exact file paths and APIs. Distinguish completed support from gated or incomplete work. Keep essential details in the result, not only in temporary files.",
  ];
}

export function treeSnapshot(run: Run, includeTerminal = false) {
  const nodes = Object.values(run.nodes);
  return {
    objective: run.objective,
    active: nodes.filter(node => node.id !== run.root && !terminal(node.status)).length,
    finished: nodes.filter(node => terminal(node.status)).length,
    nodes: nodes.filter(node => includeTerminal || !terminal(node.status)).map(node => ({
      id: node.id, parent: node.parent, name: node.name, depth: node.depth, status: node.status,
      branch: node.branch, cwd: node.worktree?.cwd, started: node.started,
      task: node.task.length > 240 ? `${node.task.slice(0, 240)}…` : node.task,
      hasResult: node.result !== undefined,
    })),
  };
}
