import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CODEX_FAST_MODE_CUSTOM_TYPE,
	defaultConfig,
	LOCK_STALE_MS,
	LOCK_TIMEOUT_MS,
	SCHEMA_VERSION,
	type LifecycleState,
	type NodeRecord,
	type RunRecord,
	type SwarmConfig,
	type TerminalState,
} from "./types.ts";

export const extensionDir = dirname(fileURLToPath(import.meta.url));
export const extensionsDir = dirname(extensionDir);
export const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const defaultConfigPath = join(agentDir, "agent-swarm.json");

export const now = () => Date.now();
export const scheduleTimer = (callback: () => void, delayMs: number) => {
	const timer = setTimeout(callback, delayMs);
	return () => clearTimeout(timer);
};
export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
export const safeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
export const validOpaqueId = (value: string, prefix: "run" | "node" | "msg") => {
	if (!new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value)) throw new Error(`Invalid swarm ${prefix} id`);
	return value;
};
export const stateRoot = () => process.env.PI_SWARM_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi", "agent-swarm");
export const runPath = (runId: string) => join(stateRoot(), "runs", validOpaqueId(runId, "run"));
export const runFile = (runId: string) => join(runPath(runId), "run.json");
export const runLock = (runId: string) => join(runPath(runId), "locks", "run.lock");
export const nodeFile = (runId: string, nodeId: string) => join(runPath(runId), "nodes", `${validOpaqueId(nodeId, "node")}.json`);
export const nodeLock = (runId: string, nodeId: string) => join(runPath(runId), "locks", `node-${safeId(nodeId)}.lock`);
export const inboxDir = (runId: string, nodeId: string) => join(runPath(runId), "inbox", validOpaqueId(nodeId, "node"));
export const messageFile = (runId: string, nodeId: string, messageId: string) => join(inboxDir(runId, nodeId), `${validOpaqueId(messageId, "msg")}.json`);
export const deliveryFile = (runId: string, nodeId: string, messageId: string) => join(inboxDir(runId, nodeId), `${validOpaqueId(messageId, "msg")}.delivery.json`);
export const deliveryLock = (runId: string, nodeId: string, messageId: string) => join(runPath(runId), "locks", `message-${safeId(nodeId)}-${safeId(messageId)}.lock`);
export const sessionIndexFile = (sessionId: string) => join(stateRoot(), "sessions", `${safeId(sessionId)}.json`);
export const sessionIndexLock = (sessionId: string) => join(stateRoot(), "locks", `session-${safeId(sessionId)}.lock`);
export const artifactDir = (runId: string) => join(runPath(runId), "artifacts");
export const worktreeDir = (runId: string, nodeId: string) => join(runPath(runId), "worktrees", validOpaqueId(nodeId, "node"));

export const ensureDir = (path: string) => mkdirSync(path, { recursive: true, mode: 0o700 });

export const readJson = <T>(path: string): T | null => {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
};

export const writeJson = (path: string, value: unknown) => {
	ensureDir(dirname(path));
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(tempPath, path);
};

const waitSync = (milliseconds: number) => {
	const buffer = new SharedArrayBuffer(4);
	Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
};

export const withLock = <T>(path: string, action: () => T): T => {
	ensureDir(dirname(path));
	const startedAt = now();
	while (true) {
		try {
			mkdirSync(path, { mode: 0o700 });
			writeFileSync(join(path, "owner"), `${process.pid}\n`, { mode: 0o600 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { recursive: true, force: true });
			} catch (statError) {
				if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
			}
			if (now() - startedAt >= LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for state lock: ${path}`);
			waitSync(10);
		}
	}
	try {
		return action();
	} finally {
		rmSync(path, { recursive: true, force: true });
	}
};

export const isTerminal = (status: LifecycleState): status is TerminalState => ["completed", "rejected", "failed", "stopped"].includes(status);

export const validTransitions: Record<LifecycleState, LifecycleState[]> = {
	starting: ["ready", "failed", "stopped"],
	ready: ["running", "starting", "failed", "stopped"],
	running: ["awaiting-review", "starting", "failed", "stopped"],
	"awaiting-review": ["rework", "completed", "rejected", "stopped"],
	rework: ["running", "awaiting-review", "starting", "failed", "stopped"],
	completed: [],
	rejected: [],
	failed: ["starting"],
	stopped: ["starting"],
};

export const transitionNode = (runId: string, nodeId: string, nextStatus: LifecycleState, mutate?: (node: NodeRecord) => void, expectedVersion?: number) => withLock(nodeLock(runId, nodeId), () => {
	const path = nodeFile(runId, nodeId);
	const node = readJson<NodeRecord>(path);
	if (!node) throw new Error(`Unknown swarm node: ${nodeId}`);
	if (expectedVersion !== undefined && node.version !== expectedVersion) throw new Error(`Swarm node ${nodeId} changed during transition (expected v${expectedVersion}, found v${node.version})`);
	if (node.status === nextStatus) {
		if (isTerminal(node.status)) return node;
		mutate?.(node);
		if (mutate) {
			node.version++;
			node.updatedAt = now();
			writeJson(path, node);
		}
		return node;
	}
	if (!validTransitions[node.status].includes(nextStatus)) {
		if (isTerminal(node.status)) return node;
		throw new Error(`Invalid swarm transition ${node.status} -> ${nextStatus} for ${nodeId}`);
	}
	mutate?.(node);
	node.status = nextStatus;
	node.version++;
	node.updatedAt = now();
	writeJson(path, node);
	return node;
});

export const updateNode = (runId: string, nodeId: string, mutate: (node: NodeRecord) => void) => withLock(nodeLock(runId, nodeId), () => {
	const path = nodeFile(runId, nodeId);
	const node = readJson<NodeRecord>(path);
	if (!node) throw new Error(`Unknown swarm node: ${nodeId}`);
	if (isTerminal(node.status)) throw new Error(`Cannot update terminal swarm node ${nodeId} (${node.status})`);
	mutate(node);
	node.version++;
	node.updatedAt = now();
	writeJson(path, node);
	return node;
});

export const updateNodeMetadata = (runId: string, nodeId: string, mutate: (node: NodeRecord) => void) => withLock(nodeLock(runId, nodeId), () => {
	const path = nodeFile(runId, nodeId);
	const node = readJson<NodeRecord>(path);
	if (!node) throw new Error(`Unknown swarm node: ${nodeId}`);
	mutate(node);
	node.version++;
	node.updatedAt = now();
	writeJson(path, node);
	return node;
});

export const readRun = (runId: string) => {
	const run = readJson<RunRecord>(runFile(runId));
	if (!run || run.schemaVersion !== SCHEMA_VERSION || run.runId !== runId) throw new Error(`Invalid swarm run: ${runId}`);
	return run;
};

export const updateRun = (runId: string, mutate: (run: RunRecord) => void) => withLock(runLock(runId), () => {
	const run = readRun(runId);
	mutate(run);
	run.updatedAt = now();
	writeJson(runFile(runId), run);
	return run;
});

export const readNode = (runId: string, nodeId: string) => {
	const node = readJson<NodeRecord>(nodeFile(runId, nodeId));
	if (!node || node.schemaVersion !== SCHEMA_VERSION || node.runId !== runId || node.nodeId !== nodeId) throw new Error(`Invalid swarm node: ${nodeId}`);
	return node;
};

export const childNodes = (runId: string, node: NodeRecord) => node.childIds.map((childId) => readNode(runId, childId));

export const rootFastModeEnabled = (ctx: ExtensionContext) => {
	type SessionEntry = { type?: string; customType?: string; data?: { enabled?: unknown } };
	const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & { getEntries?: () => readonly SessionEntry[] };
	let enabled: boolean | undefined;
	for (const entry of manager.getEntries?.() ?? []) {
		if (entry.type !== "custom" || entry.customType !== CODEX_FAST_MODE_CUSTOM_TYPE) continue;
		if (typeof entry.data?.enabled === "boolean") enabled = entry.data.enabled;
	}
	return enabled ?? false;
};

export const loadConfig = (): SwarmConfig => {
	const path = process.env.PI_SWARM_CONFIG ?? defaultConfigPath;
	const value = readJson<Partial<SwarmConfig>>(path);
	if (!value) return { ...defaultConfig, workerExtensions: [...defaultConfig.workerExtensions], protectedBranches: [...defaultConfig.protectedBranches] };
	const configuredWorkerExtensions = value.workerExtensions ?? defaultConfig.workerExtensions;
	const workerExtensions = Array.isArray(configuredWorkerExtensions) ? [...configuredWorkerExtensions] : configuredWorkerExtensions;
	if (!Array.isArray(workerExtensions) || workerExtensions.some((name) => typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(name))) throw new Error(`Invalid workerExtensions in ${path}`);
	if (!workerExtensions.includes("codex-fast-mode")) workerExtensions.push("codex-fast-mode");
	if (new Set(workerExtensions).size !== workerExtensions.length || workerExtensions.includes("agent-swarm")) throw new Error(`workerExtensions must contain unique sibling extensions and must not include ${"agent-swarm"}`);
	const extensionPaths = workerExtensions.map((name) => join(extensionsDir, name, "index.ts"));
	if (extensionPaths.some((candidate) => !existsSync(candidate))) {
		const missing = extensionPaths.find((candidate) => !existsSync(candidate));
		throw new Error(`Configured worker extension is not a repository sibling: ${missing}`);
	}
	const maxDepth = value.maxDepth ?? defaultConfig.maxDepth;
	const startupTimeoutMs = value.startupTimeoutMs ?? defaultConfig.startupTimeoutMs;
	const protectedBranches = value.protectedBranches ?? defaultConfig.protectedBranches;
	const maxInlineBytes = value.maxInlineBytes ?? defaultConfig.maxInlineBytes;
	const pollIntervalMs = value.pollIntervalMs ?? defaultConfig.pollIntervalMs;
	if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error("agent-swarm maxDepth must be a non-negative integer");
	if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1_000) throw new Error("agent-swarm startupTimeoutMs must be at least 1000");
	if (!Array.isArray(protectedBranches) || protectedBranches.some((branch) => typeof branch !== "string" || !branch)) throw new Error("agent-swarm protectedBranches must be non-empty strings");
	if (!Number.isInteger(maxInlineBytes) || maxInlineBytes < 1_024) throw new Error("agent-swarm maxInlineBytes must be at least 1024");
	if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50) throw new Error("agent-swarm pollIntervalMs must be at least 50");
	return { workerExtensions: [...workerExtensions], maxDepth, startupTimeoutMs, protectedBranches: [...protectedBranches], maxInlineBytes, pollIntervalMs };
};
