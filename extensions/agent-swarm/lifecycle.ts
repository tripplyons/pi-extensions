import { terminalStatuses, type NodeRecord, type NodeStatus, type Role, type SwarmConfig } from "./types.ts";

const transitions: Record<NodeStatus, ReadonlySet<NodeStatus>> = {
	starting: new Set(["running", "failed", "stopped"]),
	running: new Set(["awaiting-review", "failed", "stopped"]),
	"awaiting-review": new Set(["completed", "rework", "rejected", "stopped"]),
	rework: new Set(["running", "awaiting-review", "failed", "stopped"]),
	completed: new Set(),
	rejected: new Set(),
	failed: new Set(["starting"]),
	stopped: new Set(["starting"]),
};

export function assertTransition(from: NodeStatus, to: NodeStatus) {
	if (!transitions[from]?.has(to)) throw new Error(`Invalid lifecycle transition: ${from} -> ${to}`);
}

export function assertSpawnLimits(config: SwarmConfig, parent: NodeRecord, role: Role, nodes: NodeRecord[]) {
	if (parent.role !== "coordinator" && parent.role !== "manager") throw new Error(`${parent.role} cannot spawn`);
	if (role === "coordinator" || !config.allowedRoles.includes(role)) throw new Error(`Role is not enabled: ${role}`);
	if (parent.status !== "running" && parent.status !== "rework") throw new Error("Parent is not running");
	const records = new Map(nodes.map((node) => [node.nodeId, node]));
	const visited = new Set<string>();
	let current = parent;
	let depth = 1;
	while (current.parentId) {
		if (visited.has(current.nodeId)) throw new Error("Cycle in swarm ancestry");
		visited.add(current.nodeId);
		const ancestor = records.get(current.parentId);
		if (!ancestor || ancestor.runId !== parent.runId) throw new Error("Missing or cross-run ancestor");
		current = ancestor;
		depth++;
	}
	if (depth > config.maxDepth) throw new Error("Maximum swarm depth reached");
	const active = nodes.filter((node) => node.runId === parent.runId && node.role !== "coordinator" && !terminalStatuses.has(node.status));
	if (active.length >= config.maxActiveNodes) throw new Error("Maximum active swarm nodes reached");
	if (active.filter((node) => node.parentId === parent.nodeId).length >= config.maxActiveChildren) throw new Error("Maximum active children reached");
}
