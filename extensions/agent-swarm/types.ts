/** Shared with bg-bash and subagent without making this extension a runtime dependency. */
export const AGENT_SWARM_ACTIVITY_EVENT = "tripp:agent-swarm-activity";

export const SCHEMA_VERSION = 1;
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;
export const DEFAULT_INLINE_BYTES = 64 * 1024;
export const CLAIM_TIMEOUT_MS = 30_000;
export const LOCK_TIMEOUT_MS = 5_000;
export const LOCK_STALE_MS = 60_000;
export const ROOT_HEARTBEAT_INTERVAL_MS = 5_000;
export const ROOT_LEASE_TIMEOUT_MS = 30_000;
export const MAX_PANE_LINES = 500;
export const LIVE_PANE_LINES = 80;
export const LIVE_REFRESH_INTERVAL_MS = 250;
export const MAX_TEXT_PREVIEW = 1_200;
export const MAX_MESSAGE_PREVIEW = 160;
export const WORKER_ENV = "PI_SWARM_WORKER";
export const CODEX_FAST_MODE_ENV = "PI_SWARM_CODEX_FAST_MODE";
export const CODEX_FAST_MODE_CUSTOM_TYPE = "codex-fast-mode-state";
export const MONITOR_PROMPT_PREFIX = "[agent-swarm] Continue monitoring your active child agents.";
export const COMPACTION_INTERRUPTION_WINDOW_MS = 10_000;
export const INCOMPLETE_STOP_REASONS = new Set(["aborted", "error", "length"]);

export type LifecycleState =
	| "starting"
	| "ready"
	| "running"
	| "awaiting-review"
	| "rework"
	| "completed"
	| "rejected"
	| "failed"
	| "stopped";

export type TerminalState = "completed" | "rejected" | "failed" | "stopped";
export type DirtyMode = "exclude" | "commit-parent" | "commit-child" | "shared";
export type MessageKind = "message" | "instruction" | "result";
export type DeliveryState = "pending" | "claimed" | "acked";

export interface SwarmConfig {
	workerExtensions: string[];
	maxDepth: number;
	startupTimeoutMs: number;
	protectedBranches: string[];
	maxInlineBytes: number;
	pollIntervalMs: number;
}

export interface RunRecord {
	schemaVersion: number;
	runId: string;
	rootNodeId: string;
	rootSessionId: string;
	rootOwnerToken: string;
	rootOwnerPid: number;
	rootHeartbeatAt: number;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	status: "active" | "paused" | "stopped";
	config: SwarmConfig;
	tmuxSession: string;
}

export interface ResultRecord {
	text: string;
	artifactPath?: string;
	submittedAt: number;
}

export interface ReviewRecord {
	action: "accept" | "request-changes" | "reject";
	feedback?: string;
	updatedAt: number;
}

export interface NodeRecord {
	schemaVersion: number;
	runId: string;
	nodeId: string;
	parentId: string | null;
	childIds: string[];
	role: "root" | "worker";
	task: string;
	status: LifecycleState;
	version: number;
	createdAt: number;
	updatedAt: number;
	sessionId: string | null;
	sessionName: string | null;
	cwd: string;
	worktreePath: string | null;
	branch: string | null;
	sharedDirectory: boolean;
	tmuxSession: string | null;
	tmuxWindow: string | null;
	model: string | null;
	thinking: string | null;
	result: ResultRecord | null;
	resultMessageId: string | null;
	review: ReviewRecord | null;
	reviewMessageId: string | null;
	failure: string | null;
	readyAt: number | null;
	cleanedAt: number | null;
}

export interface MessageRecord {
	schemaVersion: number;
	messageId: string;
	runId: string;
	fromNodeId: string;
	toNodeId: string;
	kind: MessageKind;
	body: string;
	artifactPath?: string;
	createdAt: number;
}

export interface DeliveryRecord {
	schemaVersion: number;
	messageId: string;
	state: DeliveryState;
	claimedAt: number | null;
	claimedBy: string | null;
	ackedAt: number | null;
}

export interface SpawnDetails {
	node: NodeRecord;
	worktreeMode: DirtyMode | "clean";
}

export interface TreeDetails {
	nodes: NodeRecord[];
	rootId: string;
}

export interface MessageDetails {
	messageId: string;
	fromNodeId: string;
	toNodeId: string;
	kind: MessageKind;
	body: string;
}

export interface ReviewDetails {
	action: ReviewRecord["action"];
	node: NodeRecord;
}

export interface ObserveDetails {
	node: NodeRecord;
	output: string;
}

export interface Identity {
	runId: string;
	nodeId: string;
	isWorker: boolean;
	rootOwnerToken?: string;
}

export type CancelTimer = () => void;
export type ScheduleTimer = (callback: () => void, delayMs: number) => CancelTimer;

export type AgentSwarmDependencies = {
	now?: () => number;
	scheduleTimer?: ScheduleTimer;
};

export interface InterruptedRun {
	settledAt?: number;
	monitorWakeCount: number;
}

export interface ArmedCompaction {
	reason: string;
	monitorWakeCount: number;
}

export interface PreparedWorktree {
	cwd: string;
	branch: string | null;
	worktreePath: string | null;
	sharedDirectory: boolean;
	mode: DirtyMode | "clean";
}

export interface ClearDetails {
	runId: string;
	tmuxSession: string;
	stoppedNodeIds: string[];
	removedWorktrees: string[];
}

export const defaultConfig: SwarmConfig = {
	workerExtensions: ["bg-bash", "codex-fast-mode"],
	maxDepth: DEFAULT_MAX_DEPTH,
	startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
	protectedBranches: ["main"],
	maxInlineBytes: DEFAULT_INLINE_BYTES,
	pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};
