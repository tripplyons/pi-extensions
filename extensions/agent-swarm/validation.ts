import { SCHEMA_VERSION, type NodeRecord, type RunRecord, type SwarmConfig } from "./types.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string";
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const nullableText = (value: unknown) => value === null || text(value);
const nullableInteger = (value: unknown) => value === null || integer(value);
const id = (value: unknown, prefix: string) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);

export function validNode(value: unknown): value is NodeRecord {
	if (!record(value) || value.schemaVersion !== SCHEMA_VERSION || !id(value.runId, "run") || !id(value.nodeId, "node")) return false;
	if (value.parentId !== null && !id(value.parentId, "node")) return false;
	if (value.reviewTargetId !== null && !id(value.reviewTargetId, "node")) return false;
	if (!Array.isArray(value.childIds) || !value.childIds.every((child) => id(child, "node")) || new Set(value.childIds).size !== value.childIds.length) return false;
	if (value.parentId === value.nodeId || value.childIds.includes(value.nodeId)) return false;
	if (!["coordinator", "manager", "worker", "reviewer"].includes(value.role as string)) return false;
	if ((value.role === "coordinator") !== (value.parentId === null)) return false;
	if (!["starting", "running", "awaiting-review", "rework", "completed", "rejected", "failed", "stopped"].includes(value.status as string)) return false;
	if (!["task", "cwd"].every((key) => text(value[key]))) return false;
	if (!["version", "createdAt", "updatedAt"].every((key) => integer(value[key]))) return false;
	if (value.lastHeartbeatAt !== undefined && !integer(value.lastHeartbeatAt)) return false;
	if (value.estimatedCost !== undefined && (typeof value.estimatedCost !== "number" || !Number.isFinite(value.estimatedCost) || value.estimatedCost < 0)) return false;
	if (!["deadlineAt", "pausedAt", "pid", "cleanedAt"].every((key) => nullableInteger(value[key]))) return false;
	if (!["sessionId", "branch", "baseCommit", "integrationCommit", "failure", "tmuxSession", "tmuxWindow", "model", "thinking"].every((key) => nullableText(value[key]))) return false;
	if (value.sandbox !== null) {
		if (!record(value.sandbox) || value.sandbox.backend !== "macos-sandbox-exec" || !text(value.sandbox.profile)) return false;
		if (typeof value.sandbox.readOnlyWorktree !== "boolean" || value.sandbox.network !== "tcp-udp-outbound" || value.sandbox.lifecycle !== "process-group") return false;
	}
	if (value.result !== null) {
		if (!record(value.result) || !text(value.result.text) || !nullableText(value.result.commit) || !integer(value.result.submittedAt)) return false;
		if (value.result.verification !== undefined && !text(value.result.verification)) return false;
	}
	if (value.review !== null) {
		if (!record(value.review) || !["accept", "request-changes", "reject"].includes(value.review.action as string) || !integer(value.review.updatedAt)) return false;
		if (value.review.feedback !== undefined && !text(value.review.feedback)) return false;
	}
	return true;
}

export function validRun(value: unknown): value is RunRecord {
	if (!record(value) || value.schemaVersion !== SCHEMA_VERSION || !id(value.runId, "run") || !id(value.rootNodeId, "node")) return false;
	if (value.clearedAt !== undefined && !integer(value.clearedAt)) return false;
	if (!["rootSessionId", "ownerToken", "cwd", "gitRoot", "gitCommonDir", "tmuxSession"].every((key) => text(value[key]) && value[key] !== "")) return false;
	if (!["ownerPid", "heartbeatAt", "createdAt", "updatedAt"].every((key) => integer(value[key]))) return false;
	if (!["active", "paused", "stopped"].includes(value.status as string)) return false;
	try { validateConfig(value.config); return true; }
	catch { return false; }
}

export function validateConfig(value: unknown): asserts value is SwarmConfig {
	if (!record(value)) throw new Error("agent-swarm configuration must be an object");
	for (const [key, minimum] of [["maxDepth", 1], ["maxActiveChildren", 1], ["maxActiveNodes", 1], ["startupTimeoutMs", 1000], ["workerTimeoutMs", 1000], ["pollIntervalMs", 50], ["maxInlineBytes", 1024]] as const) {
		if (!integer(value[key]) || (value[key] as number) < minimum) throw new Error(`agent-swarm ${key} must be an integer of at least ${minimum}`);
	}
	if ((value.maxActiveChildren as number) > (value.maxActiveNodes as number)) throw new Error("maxActiveChildren cannot exceed maxActiveNodes");
	if (!Array.isArray(value.protectedBranches) || !value.protectedBranches.every((item) => text(item) && item)) throw new Error("protectedBranches must contain non-empty names");
	if (!Array.isArray(value.allowedRoles) || !value.allowedRoles.every((item) => ["manager", "worker", "reviewer"].includes(item))) throw new Error("allowedRoles contains an unknown role");
	if (value.fastMode !== undefined && typeof value.fastMode !== "boolean") throw new Error("fastMode must be a boolean");
	for (const key of ["roleModels", "roleThinking"]) {
		if (value[key] === undefined) continue;
		if (!record(value[key])) throw new Error(`${key} must be an object`);
		for (const [role, setting] of Object.entries(value[key])) {
			if (!["manager", "worker", "reviewer"].includes(role) || typeof setting !== "string" || !setting.trim()) throw new Error(`Invalid ${key} entry: ${role}`);
			if (key === "roleModels" && !setting.includes("/")) throw new Error("Role models require provider/model names");
			if (key === "roleThinking" && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(setting)) throw new Error(`Invalid thinking level: ${setting}`);
		}
	}
}
