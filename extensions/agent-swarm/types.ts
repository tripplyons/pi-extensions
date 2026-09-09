export const SCHEMA_VERSION = 2;
export const WORKER_ENV = "PI_SWARM_WORKER";

export type Role = "coordinator" | "manager" | "worker" | "reviewer";
export type NodeStatus = "starting" | "running" | "awaiting-review" | "rework" | "completed" | "rejected" | "failed" | "stopped";
export type RunStatus = "active" | "paused" | "stopped";
export type ReviewAction = "accept" | "request-changes" | "reject";
export type RequestKind = "ready" | "heartbeat" | "spawn" | "send" | "complete" | "review" | "integrate" | "stop" | "restart" | "cleanup";

export interface SwarmConfig {
	maxDepth: number;
	maxActiveChildren: number;
	maxActiveNodes: number;
	startupTimeoutMs: number;
	workerTimeoutMs: number;
	pollIntervalMs: number;
	maxInlineBytes: number;
	protectedBranches: string[];
	allowedRoles: Exclude<Role, "coordinator">[];
	roleModels?: Partial<Record<Exclude<Role, "coordinator">, string>>;
	roleThinking?: Partial<Record<Exclude<Role, "coordinator">, string>>;
}

export const defaultConfig: SwarmConfig = {
	maxDepth: 2,
	maxActiveChildren: 4,
	maxActiveNodes: 8,
	startupTimeoutMs: 30_000,
	workerTimeoutMs: 30 * 60_000,
	pollIntervalMs: 250,
	maxInlineBytes: 64 * 1024,
	protectedBranches: ["main", "master"],
	allowedRoles: ["manager", "worker", "reviewer"],
};

export interface ResultRecord {
	text: string;
	commit: string | null;
	verification?: string;
	submittedAt: number;
}

export interface ReviewRecord {
	action: ReviewAction;
	feedback?: string;
	updatedAt: number;
}

export interface SandboxRecord {
	backend: "macos-sandbox-exec";
	profile: string;
	readOnlyWorktree: boolean;
	network: "tcp-udp-outbound";
	lifecycle: "process-group";
}

export interface NodeRecord {
	schemaVersion: number;
	runId: string;
	nodeId: string;
	parentId: string | null;
	childIds: string[];
	role: Role;
	task: string;
	reviewTargetId: string | null;
	status: NodeStatus;
	version: number;
	createdAt: number;
	updatedAt: number;
	lastHeartbeatAt?: number;
	deadlineAt: number | null;
	pausedAt: number | null;
	sessionId: string | null;
	cwd: string;
	branch: string | null;
	baseCommit: string | null;
	result: ResultRecord | null;
	review: ReviewRecord | null;
	integrationCommit: string | null;
	failure: string | null;
	tmuxSession: string | null;
	tmuxWindow: string | null;
	pid: number | null;
	model: string | null;
	thinking: string | null;
	sandbox: SandboxRecord | null;
	cleanedAt: number | null;
}

export interface RunRecord {
	clearedAt?: number;
	schemaVersion: number;
	runId: string;
	rootNodeId: string;
	rootSessionId: string;
	ownerToken: string;
	ownerPid: number;
	heartbeatAt: number;
	cwd: string;
	gitRoot: string;
	gitCommonDir: string;
	createdAt: number;
	updatedAt: number;
	status: RunStatus;
	config: SwarmConfig;
	tmuxSession: string;
}

export interface SwarmRequest {
	schemaVersion: number;
	requestId: string;
	runId: string;
	nodeId: string;
	token: string;
	kind: RequestKind;
	expectedVersion: number;
	createdAt: number;
	payload: Record<string, unknown>;
}

export interface SwarmResponse {
	schemaVersion: number;
	requestId: string;
	ok: boolean;
	createdAt: number;
	result?: unknown;
	error?: string;
}

export interface MessageRecord {
	schemaVersion: number;
	runId: string;
	messageId: string;
	fromNodeId: string;
	toNodeId: string;
	kind: "message" | "instruction" | "result";
	body: string;
	createdAt: number;
	claimedAt: number | null;
	acknowledgedAt: number | null;
}

export const terminalStatuses = new Set<NodeStatus>(["completed", "rejected", "failed", "stopped"]);

export const roleCanSpawn = (role: Role) => role === "coordinator" || role === "manager";
export const roleCanIntegrate = (role: Role) => role === "manager";
export const directRelatives = (left: NodeRecord, right: NodeRecord) => left.runId === right.runId && (left.parentId === right.nodeId || right.parentId === left.nodeId);
