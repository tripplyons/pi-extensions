import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig, type NodeRecord, type RunRecord, type SwarmConfig, type SwarmRequest, type SwarmResponse } from "./types.ts";
import { assertTransition } from "./lifecycle.ts";
import { validNode, validRun, validateConfig } from "./validation.ts";

export const now = () => Date.now();
export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
export const newToken = () => randomBytes(32).toString("base64url");
export const stateRoot = () => process.env.PI_SWARM_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi", "agent-swarm");
export const runDir = (runId: string) => join(stateRoot(), "runs", opaqueId(runId, "run"));
export const runFile = (runId: string) => join(runDir(runId), "control", "run.json");
export const nodeFile = (runId: string, nodeId: string) => join(runDir(runId), "control", "nodes", `${opaqueId(nodeId, "node")}.json`);
export const tokenFile = (runId: string, nodeId: string) => join(runDir(runId), "control", "tokens", opaqueId(nodeId, "node"));
export const nodeDir = (runId: string, nodeId: string) => join(runDir(runId), "nodes", opaqueId(nodeId, "node"));
export const outboxDir = (runId: string, nodeId: string) => join(nodeDir(runId, nodeId), "outbox");
export const inboxDir = (runId: string, nodeId: string) => join(nodeDir(runId, nodeId), "inbox");
export const workerHome = (runId: string, nodeId: string) => join(nodeDir(runId, nodeId), "home");
export const workerTmp = (runId: string, nodeId: string) => join(nodeDir(runId, nodeId), "tmp");
export const worktreeDir = (runId: string, nodeId: string) => join(runDir(runId), "worktrees", opaqueId(nodeId, "node"));
export const auditDir = (runId: string) => join(runDir(runId), "control", "audit");
export const sessionFile = (sessionId: string) => join(stateRoot(), "sessions", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
const opaqueId = (value: string, prefix: "run" | "node" | "req") => {
	if (!new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value)) throw new Error(`Invalid swarm ${prefix} id`);
	return value;
};
export const ensureDir = (path: string) => mkdirSync(path, { recursive: true, mode: 0o700 });
export const readJson = <T>(path: string): T | null => {
	try { return JSON.parse(readFileSync(path, "utf8")) as T; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
};
export const writeJson = (path: string, value: unknown) => {
	ensureDir(dirname(path));
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		try {
			writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
			fsyncSync(fd);
		} finally { closeSync(fd); }
		renameSync(temporary, path);
	}
	finally { rmSync(temporary, { force: true }); }
	const directory = openSync(dirname(path), "r");
	try { fsyncSync(directory); }
	finally { closeSync(directory); }
};
export const readRun = (runId: string) => {
	const run = readJson<RunRecord>(runFile(runId));
	if (!validRun(run) || run.runId !== runId) throw new Error(`Invalid swarm run: ${runId}`);
	return run;
};
export const readNode = (runId: string, nodeId: string) => {
	const node = readJson<NodeRecord>(nodeFile(runId, nodeId));
	if (!validNode(node) || node.runId !== runId || node.nodeId !== nodeId) throw new Error(`Invalid swarm node: ${nodeId}`);
	return node;
};
export const updateRun = (runId: string, mutate: (run: RunRecord) => void) => {
	const run = readRun(runId);
	mutate(run);
	if (!validRun(run) || run.runId !== runId) throw new Error(`Invalid swarm run update: ${runId}`);
	run.updatedAt = now(); writeJson(runFile(runId), run); return run;
};
export const updateNode = (runId: string, nodeId: string, mutate: (node: NodeRecord) => void, expectedVersion?: number) => {
	const node = readNode(runId, nodeId);
	if (expectedVersion !== undefined && node.version !== expectedVersion) throw new Error(`Node ${nodeId} changed: expected v${expectedVersion}, found v${node.version}`);
	const previousStatus = node.status;
	mutate(node);
	if (!validNode(node) || node.runId !== runId || node.nodeId !== nodeId) throw new Error(`Invalid swarm node update: ${nodeId}`);
	if (node.status !== previousStatus) assertTransition(previousStatus, node.status);
	node.version++; node.updatedAt = now(); writeJson(nodeFile(runId, nodeId), node); return node;
};
export const depthOf = (runId: string, node: NodeRecord) => {
	let depth = 0; let current = node;
	const visited = new Set<string>();
	while (current.parentId) {
		if (visited.has(current.nodeId)) throw new Error("Cycle in swarm ancestry");
		visited.add(current.nodeId);
		depth++; current = readNode(runId, current.parentId);
	}
	return depth;
};
export const descendants = (runId: string, node: NodeRecord): NodeRecord[] => {
	const result: NodeRecord[] = [];
	const visited = new Set([node.nodeId]);
	const pending = [node];
	while (pending.length) {
		const parent = pending.pop()!;
		for (const childId of parent.childIds) {
			if (visited.has(childId)) throw new Error("Cycle or duplicate child in swarm tree");
			visited.add(childId);
			const child = readNode(runId, childId);
			if (child.parentId !== parent.nodeId) throw new Error("Inconsistent swarm parent-child relationship");
			result.push(child); pending.push(child);
		}
	}
	return result;
};
export const loadConfig = () => {
	const path = process.env.PI_SWARM_CONFIG ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "agent-swarm.json");
	const input = readJson<Partial<SwarmConfig>>(path) ?? {};
	if (typeof input !== "object" || Array.isArray(input)) throw new Error(`${path}: configuration must be an object`);
	const config = { ...defaultConfig, ...input, protectedBranches: input.protectedBranches ?? [...defaultConfig.protectedBranches], allowedRoles: input.allowedRoles ?? [...defaultConfig.allowedRoles] };
	validateConfig(config);
	return config;
};
export const queuedRequests = (runId: string, nodeId: string) => {
	const directory = outboxDir(runId, nodeId);
	if (!existsSync(directory)) return [];
	return readdirSync(directory).filter((name) => /^req_[A-Za-z0-9]+\.json$/.test(name)).sort().map((name) => join(directory, name));
};
export const writeRequest = (request: SwarmRequest) => writeJson(join(outboxDir(request.runId, request.nodeId), `${opaqueId(request.requestId, "req")}.json`), request);
export const responseFile = (runId: string, nodeId: string, requestId: string) => join(inboxDir(runId, nodeId), `${opaqueId(requestId, "req")}.json`);
export const writeResponse = (runId: string, nodeId: string, response: SwarmResponse) => writeJson(responseFile(runId, nodeId, response.requestId), response);
