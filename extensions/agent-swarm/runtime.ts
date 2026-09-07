import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { isEscalatedStaleWorker, isStaleWorker, SwarmTreeView, type SwarmTreeOutputReader } from "./tree-ui.ts";
import {
	AGENT_SWARM_ACTIVITY_EVENT,
	CLAIM_TIMEOUT_MS,
	CODEX_FAST_MODE_ENV,
	COMPACTION_INTERRUPTION_WINDOW_MS,
	INCOMPLETE_STOP_REASONS,
	LIVE_PANE_LINES,
	LIVE_REFRESH_INTERVAL_MS,
	MAX_PANE_LINES,
	MAX_TEXT_PREVIEW,
	MONITOR_PROMPT_PREFIX,
	ROOT_HEARTBEAT_INTERVAL_MS,
	ROOT_LEASE_TIMEOUT_MS,
	SCHEMA_VERSION,
	WORKER_ENV,
	type AgentSwarmDependencies,
	type CancelTimer,
	type ClearDetails,
	type DeliveryRecord,
	type DirtyMode,
	type Identity,
	type InterruptedRun,
	type ArmedCompaction,
	type LifecycleState,
	type MessageKind,
	type MessageRecord,
	type NodeRecord,
	type ResultRecord,
	type ReviewRecord,
	type RunRecord,
	type SpawnDetails,
} from "./types.ts";
import {
	artifactDir,
	childNodes,
	deliveryFile,
	deliveryLock,
	ensureDir,
	extensionsDir,
	inboxDir,
	isTerminal,
	loadConfig,
	messageFile,
	newId,
	now,
	nodeFile,
	readJson,
	readNode,
	readRun,
	rootFastModeEnabled,
	runFile,
	runPath,
	safeId,
	scheduleTimer,
	sessionIndexFile,
	sessionIndexLock,
	stateRoot,
	transitionNode,
	updateNode,
	updateNodeMetadata,
	updateRun,
	withLock,
	writeJson,
} from "./state.ts";
import { gitInfo, gitRun, isDirty, prepareWorktree, removeWorktree } from "./git.ts";
import { capturePane, runTmux, tmuxSessionExists, tmuxWindowAlive, tmuxWindowExists } from "./tmux.ts";

const extensionFile = fileURLToPath(new URL("./index.ts", import.meta.url));

class RootOwnershipError extends Error {}

const isProcessAlive = (pid: number) => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const rootOwnerAppearsLive = (run: RunRecord) => {
	const heartbeatAge = now() - run.rootHeartbeatAt;
	const heartbeatFresh = Number.isFinite(heartbeatAge) && heartbeatAge >= 0 && heartbeatAge <= ROOT_LEASE_TIMEOUT_MS;
	return heartbeatFresh && (!Number.isInteger(run.rootOwnerPid) || isProcessAlive(run.rootOwnerPid));
};

const lastAssistantStopReason = (event: AgentEndEvent) => {
	for (let index = event.messages.length - 1; index >= 0; index--) {
		const message = event.messages[index];
		if (message.role === "assistant") return message.stopReason;
	}
	return undefined;
};

const resultText = (text: string) => text.length > MAX_TEXT_PREVIEW ? `${text.slice(0, MAX_TEXT_PREVIEW)}…` : text;
const writeArtifact = (run: RunRecord, messageId: string, text: string) => {
	ensureDir(join(runPath(run.runId), "artifacts"));
	const name = `${messageId}.txt`;
	writeFileSync(join(artifactDir(run.runId), name), text, { mode: 0o600 });
	return `artifacts/${name}`;
};

const payloadFor = (run: RunRecord, messageId: string, body: string) => {
	if (Buffer.byteLength(body, "utf8") <= run.config.maxInlineBytes) return { body };
	const artifactPath = writeArtifact(run, messageId, body);
	return { body: `[inline result exceeded ${run.config.maxInlineBytes} bytes; read ${artifactPath}]`, artifactPath };
};

const formatMessage = (message: MessageRecord) => {
	const header = `[agent-swarm ${message.kind} ${message.messageId}] from ${message.fromNodeId}`;
	return message.artifactPath ? `${header}\n${message.body}\nArtifact: ${join(runPath(message.runId), message.artifactPath)}` : `${header}\n${message.body}`;
};

const messageFiles = (runId: string, nodeId: string) => {
	const dir = inboxDir(runId, nodeId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.endsWith(".json") && !name.endsWith(".delivery.json")).sort().map((name) => join(dir, name));
};

const visibleNodes = (run: RunRecord, node: NodeRecord) => {
	if (node.nodeId === run.rootNodeId) {
		const all: NodeRecord[] = [];
		const visit = (candidate: NodeRecord) => {
			all.push(candidate);
			for (const child of childNodes(run.runId, candidate)) visit(child);
		};
		visit(node);
		return all;
	}
	const visible = [node, ...(node.parentId ? [readNode(run.runId, node.parentId)] : []), ...childNodes(run.runId, node)];
	return visible.filter((candidate, index, values) => values.findIndex((item) => item.nodeId === candidate.nodeId) === index);
};

const treeText = (nodes: NodeRecord[]) => {
	const byParent = new Map<string | null, NodeRecord[]>();
	const nodeIds = new Set(nodes.map((node) => node.nodeId));
	for (const node of nodes) byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node]);
	const lines: string[] = [];
	function visit(parentId: string | null, depth: number) {
		for (const node of byParent.get(parentId) ?? []) visitNode(node, depth);
	}
	function visitNode(node: NodeRecord, depth: number) {
		const branch = node.branch ? ` branch=${node.branch}` : "";
		const worktree = node.worktreePath ? ` worktree=${node.worktreePath}` : node.sharedDirectory ? " shared=true" : "";
		lines.push(`${"  ".repeat(depth)}${node.nodeId} [${node.status}] task=${resultText(node.task)}${branch}${worktree}${node.tmuxWindow ? ` tmux=${node.tmuxSession}:${node.tmuxWindow}` : ""}`);
		visit(node.nodeId, depth + 1);
	}
	const roots = nodes.filter((node) => node.parentId === null || !nodeIds.has(node.parentId));
	for (const root of roots) visitNode(root, 0);
	if (lines.length === 0) return "No visible swarm nodes";
	const observedAt = now();
	const stale = nodes.filter((node) => isStaleWorker(node, observedAt));
	const escalated = stale.filter((node) => isEscalatedStaleWorker(node, observedAt));
	if (stale.length > 0) {
		const action = escalated.length > 0
			? "Inspect with swarm_observe; then swarm_restart or swarm_stop."
			: "Inspect with swarm_observe; stop with swarm_stop if needed.";
		lines.push("", `Warning: ${stale.length} worker${stale.length === 1 ? "" : "s"} may be stale (${stale.map((node) => node.nodeId).join(", ")}).`, action);
	}
	const cleanup = nodes.filter((node) => isTerminal(node.status) && node.worktreePath && !node.cleanedAt);
	if (cleanup.length > 0) {
		lines.push("", `Cleanup: run swarm_cleanup or swarm_cleanup <nodeId> for ${cleanup.map((node) => node.nodeId).join(", ")} after verifying the branch handoff; worktrees must be clean.`);
	}
	return lines.join("\n");
};


class SwarmRuntime {
	private identity: Identity | null = null;
	private context: ExtensionContext | null = null;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private stopped = false;
	private agentRunning = false;
	private activityGeneration = 0;
	private monitorWokenGeneration = -1;
	private monitorWokenChildren = "";
	private knownStatuses = new Map<string, LifecycleState>();
	private deliveredMessages = new Set<string>();
	private interruptedRun: InterruptedRun | undefined;
	private armedCompaction: ArmedCompaction | undefined;
	private cancelCompactionWakeTimer: CancelTimer | undefined;
	private compactionWakeTimerGeneration = 0;
	private monitorWakeCount = 0;
	private lastRootHeartbeatAt = 0;
	private readonly clock: () => number;
	private readonly schedule: ScheduleTimer;

	constructor(private readonly pi: ExtensionAPI, dependencies: AgentSwarmDependencies = {}) {
		this.clock = dependencies.now ?? now;
		this.schedule = dependencies.scheduleTimer ?? scheduleTimer;
	}

	async startSession(ctx: ExtensionContext) {
		this.clearCompactionRecovery();
		this.identity = null;
		this.context = ctx;
		this.stopped = false;
		this.agentRunning = false;
		this.activityGeneration = 0;
		this.monitorWokenGeneration = -1;
		this.monitorWokenChildren = "";
		this.knownStatuses.clear();
		this.deliveredMessages.clear();
		const sessionId = ctx.sessionManager.getSessionId();
		const workerRunId = process.env.PI_SWARM_RUN_ID;
		const workerNodeId = process.env.PI_SWARM_NODE_ID;
		if (process.env[WORKER_ENV] === "1" && workerRunId && workerNodeId) {
			const node = readNode(workerRunId, workerNodeId);
			if (node.sessionId && node.sessionId !== sessionId) throw new Error(`Swarm worker session mismatch for ${workerNodeId}`);
			if (!node.sessionId) updateNode(workerRunId, workerNodeId, (current) => { current.sessionId = sessionId; current.sessionName = this.sessionName(ctx); });
			this.identity = { runId: workerRunId, nodeId: workerNodeId, isWorker: true };
			const latestWorker = readNode(workerRunId, workerNodeId);
			if (latestWorker.status === "starting") transitionNode(workerRunId, workerNodeId, "ready", (current) => { current.readyAt = now(); }, latestWorker.version);
		} else {
			const index = readJson<{ runId: string; nodeId: string }>(sessionIndexFile(sessionId));
			if (index) {
				const node = readNode(index.runId, index.nodeId);
				if (node.role === "root") {
					let run = readRun(index.runId);
					if (run.rootSessionId !== sessionId) throw new RootOwnershipError(`Swarm ${run.runId} root ownership moved to another Pi session`);
					const previousOwnerToken = run.rootOwnerToken;
					run = updateRun(run.runId, (current) => {
						if (current.rootSessionId !== sessionId || current.rootOwnerToken !== previousOwnerToken) {
							throw new RootOwnershipError(`Swarm ${current.runId} root ownership changed while reconnecting`);
						}
						if (current.rootOwnerPid !== process.pid && rootOwnerAppearsLive(current)) {
							throw new RootOwnershipError(`Swarm ${current.runId} is already active in another Pi process`);
						}
						current.rootOwnerToken = newId("owner");
						current.rootOwnerPid = process.pid;
						current.rootHeartbeatAt = now();
					});
					this.identity = { runId: index.runId, nodeId: index.nodeId, isWorker: false, rootOwnerToken: run.rootOwnerToken };
					this.lastRootHeartbeatAt = run.rootHeartbeatAt;
					if (!isTerminal(node.status) && node.status !== "running") transitionNode(index.runId, index.nodeId, "running", undefined, node.version);
				}
			}
		}
		this.refreshStatus(ctx);
		if (this.identity) this.startPolling();
		if (this.identity && !this.identity.isWorker) {
			const run = readRun(this.identity.runId);
			if (run.status === "active") {
				const repaired = await this.repairDeadWorkers(run, ctx);
				if (repaired.length > 0) this.noteActivity({ kind: "repair", source: "resume", nodeId: this.identity.nodeId, childIds: repaired });
			}
		}
	}

	async stopSession(reason?: string) {
		this.clearCompactionRecovery();
		if (reason !== "reload" && this.identity && !this.identity.isWorker) {
			const identity = this.identity;
			try {
				updateRun(identity.runId, (run) => {
					if (run.rootOwnerToken !== identity.rootOwnerToken) return;
					run.rootOwnerPid = 0;
					run.rootHeartbeatAt = 0;
				});
			} catch {}
		}
		this.stopped = true;
		this.agentRunning = false;
		this.lastRootHeartbeatAt = 0;
		this.monitorWokenGeneration = -1;
		this.monitorWokenChildren = "";
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		this.context = null;
	}

	agentStarted() {
		// Any run that starts before the zero-delay recovery wake owns the
		// continuation. This includes Pi core retries and Goal/autoresearch.
		this.clearCompactionRecovery();
		this.agentRunning = true;
	}

	// agent_end can be followed by an automatic retry, compaction, or queued
	// continuation. Keep the run marked active until agent_settled.
	agentEnded(event: AgentEndEvent) {
		const stopReason = lastAssistantStopReason(event);
		this.interruptedRun = stopReason && INCOMPLETE_STOP_REASONS.has(stopReason)
			? { monitorWakeCount: this.monitorWakeCount }
			: undefined;
	}

	agentSettled(ctx: ExtensionContext) {
		if (this.interruptedRun && this.interruptedRun.settledAt === undefined) {
			this.interruptedRun.settledAt = this.clock();
		}
		this.agentRunning = false;
		this.wakeParentForMonitoring(ctx);
	}

	beforeCompaction(event: SessionBeforeCompactEvent) {
		this.cancelCompactionWake();
		this.armedCompaction = undefined;
		const candidate = this.interruptedRun;
		if (!this.identity || !candidate || event.reason === "overflow" || event.willRetry) return;
		if (candidate.settledAt !== undefined) {
			const age = this.clock() - candidate.settledAt;
			if (age < 0 || age > COMPACTION_INTERRUPTION_WINDOW_MS) {
				this.interruptedRun = undefined;
				return;
			}
		}
		// A semantic monitor queued after the interruption already owns recovery.
		if (this.monitorWakeCount !== candidate.monitorWakeCount) {
			this.interruptedRun = undefined;
			return;
		}
		// Capture eligibility before summary generation, which can take longer
		// than the interruption-association window.
		this.armedCompaction = { reason: event.reason, monitorWakeCount: candidate.monitorWakeCount };
	}

	compactionSucceeded(event: SessionCompactEvent, ctx: ExtensionContext) {
		const candidate = this.armedCompaction;
		this.armedCompaction = undefined;
		this.interruptedRun = undefined;
		if (!candidate || event.willRetry || event.reason !== candidate.reason) return;
		if (this.monitorWakeCount !== candidate.monitorWakeCount) return;

		this.cancelCompactionWake();
		const generation = this.compactionWakeTimerGeneration;
		this.cancelCompactionWakeTimer = this.schedule(() => {
			if (generation !== this.compactionWakeTimerGeneration) return;
			this.cancelCompactionWakeTimer = undefined;
			// Threshold compaction can still reach agent_settled after the success
			// event. If that generic path already woke monitoring, do not duplicate it.
			if (this.monitorWakeCount !== candidate.monitorWakeCount) return;
			this.wakeParentForMonitoring(ctx, true);
		}, 0);
	}

	activityOccurred(value: unknown) {
		const activity = value as { source?: string; nodeId?: string } | null;
		if (this.identity && !this.identity.isWorker) {
			try { this.assertRootOwnership(this.identity); } catch { return; }
		}
		if (this.identity && activity?.source !== "inbox" && activity?.nodeId) {
			try {
				const run = readRun(this.identity.runId);
				const current = readNode(run.runId, this.identity.nodeId);
				if (!current.childIds.includes(activity.nodeId)) return;
			} catch {
				return;
			}
		}
		this.activityGeneration++;
		if (activity?.source === "inbox") {
			this.monitorWokenGeneration = this.activityGeneration;
			try {
				const run = readRun(this.identity!.runId);
				const current = readNode(run.runId, this.identity!.nodeId);
				this.monitorWokenChildren = childNodes(run.runId, current).filter((child) => !isTerminal(child.status)).map((child) => child.nodeId).sort().join("|");
			} catch {
				this.monitorWokenChildren = "";
			}
		}
		if (this.stopped || !this.identity || this.agentRunning) return;
		// Inbox delivery already queues a steer turn for this session. A second
		// monitor wake for that same message would create duplicate turns.
		if (activity?.source === "inbox") return;
		if (this.context) this.wakeParentForMonitoring(this.context);
	}

	beforeAgentStart(systemPrompt: string, prompt?: string) {
		void prompt;
		const identity = this.requireIdentity(true);
		if (!identity?.isWorker) return undefined;
		const node = readNode(identity.runId, identity.nodeId);
		const parent = node.parentId ? readNode(identity.runId, node.parentId) : null;
		const contract = [
			"## Pi agent-swarm worker contract",
			`Node: ${node.nodeId}`,
			`Parent: ${parent?.nodeId ?? "none"}`,
			`Status: ${node.status}`,
			`State root: ${stateRoot()}`,
			"The durable assignment is available through the swarm_task tool; do not infer it from this prompt.",
			"Only your direct parent may issue authoritative instructions. Use swarm_send for direct parent/child messages and swarm_complete when your result is ready for review.",
			"Stay on your assigned worktree/branch. The main branch is user-only.",
		].join("\n");
		if (node.status === "ready") transitionNode(identity.runId, identity.nodeId, "running", undefined, node.version);
		return { systemPrompt: `${systemPrompt}\n\n${contract}` };
	}

	isAttached() {
		return this.identity !== null;
	}

	needsObjective() {
		const identity = this.requireIdentity(true);
		if (!identity || identity.isWorker) return false;
		const root = readNode(identity.runId, identity.nodeId);
		return root.role === "root" && !root.task.trim();
	}

	setObjective(objective: string) {
		const objectiveText = objective.trim();
		if (!objectiveText) throw new Error("Swarm objective cannot be empty");
		const identity = this.requireIdentity();
		if (identity.isWorker) throw new Error("Only the swarm root can set the swarm objective");
		return updateNode(identity.runId, identity.nodeId, (root) => {
			if (root.role !== "root") throw new Error("Only the swarm root can set the swarm objective");
			if (root.task.trim()) throw new Error("The swarm objective is already set");
			root.task = objectiveText;
		});
	}

	activateRoot(ctx: ExtensionContext, objective: string) {
		if (this.identity) return null;
		this.clearCompactionRecovery();
		const sessionId = ctx.sessionManager.getSessionId();
		const existing = readJson<{ runId: string }>(sessionIndexFile(sessionId));
		if (existing) throw new Error(`This Pi session already has swarm run ${existing.runId}; reconnect it instead of creating another root`);
		const config = loadConfig();
		const runId = newId("run");
		const nodeId = newId("node");
		const rootOwnerToken = newId("owner");
		const cwd = ctx.cwd;
		const run: RunRecord = {
			schemaVersion: SCHEMA_VERSION,
			runId,
			rootNodeId: nodeId,
			rootSessionId: sessionId,
			rootOwnerToken,
			rootOwnerPid: process.pid,
			rootHeartbeatAt: now(),
			cwd,
			createdAt: now(),
			updatedAt: now(),
			status: "active",
			config,
			tmuxSession: `pi-swarm-${safeId(runId.slice(-16))}`,
		};
		const node: NodeRecord = {
			schemaVersion: SCHEMA_VERSION,
			runId,
			nodeId,
			parentId: null,
			childIds: [],
			role: "root",
			task: objective.trim(),
			status: "running",
			version: 1,
			createdAt: now(),
			updatedAt: now(),
			sessionId,
			sessionName: this.sessionName(ctx),
			cwd,
			worktreePath: null,
			branch: gitInfo(cwd)?.branch ?? null,
			sharedDirectory: true,
			tmuxSession: null,
			tmuxWindow: null,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			thinking: ctx.thinkingLevel,
			result: null,
			resultMessageId: null,
			review: null,
			reviewMessageId: null,
			failure: null,
			readyAt: now(),
			cleanedAt: null,
		};
		ensureDir(runPath(runId));
		ensureDir(join(runPath(runId), "nodes"));
		ensureDir(join(runPath(runId), "locks"));
		writeJson(runFile(runId), run);
		writeJson(nodeFile(runId, nodeId), node);
		withLock(sessionIndexLock(sessionId), () => writeJson(sessionIndexFile(sessionId), { schemaVersion: SCHEMA_VERSION, sessionId, runId, nodeId, updatedAt: now() }));
		this.identity = { runId, nodeId, isWorker: false, rootOwnerToken };
		this.lastRootHeartbeatAt = run.rootHeartbeatAt;
		this.context = ctx;
		this.startPolling();
		this.refreshStatus(ctx);
		this.noteActivity({ kind: "activate", source: "state", nodeId, runId });
		return run;
	}

	requireIdentity(): Identity;
	requireIdentity(allowMissing: true): Identity | null;
	requireIdentity(allowMissing = false): Identity | null {
		if (!this.identity) {
			if (allowMissing) return null;
			throw new Error("Swarm is not active in this Pi session. Run /swarm:start first.");
		}
		this.assertRootOwnership(this.identity);
		return this.identity;
	}

	private assertRootOwnership(identity: Identity) {
		if (identity.isWorker) return;
		const run = readRun(identity.runId);
		const sessionId = this.context?.sessionManager.getSessionId();
		if (!identity.rootOwnerToken || run.rootOwnerToken !== identity.rootOwnerToken || !sessionId || run.rootSessionId !== sessionId) {
			throw new RootOwnershipError(`Swarm ${run.runId} root ownership moved to another Pi session`);
		}
	}

	private refreshRootHeartbeat(force = false) {
		if (!this.identity || this.identity.isWorker) return;
		const observedAt = now();
		if (!force && observedAt - this.lastRootHeartbeatAt < ROOT_HEARTBEAT_INTERVAL_MS) return;
		const identity = this.identity;
		updateRun(identity.runId, (run) => {
			if (run.rootOwnerToken !== identity.rootOwnerToken) throw new RootOwnershipError(`Swarm ${run.runId} root ownership moved to another Pi session`);
			run.rootOwnerPid = process.pid;
			run.rootHeartbeatAt = observedAt;
		});
		this.lastRootHeartbeatAt = observedAt;
	}

	getCurrentNode() {
		const identity = this.requireIdentity();
		return readNode(identity.runId, identity.nodeId);
	}

	getRun() {
		const identity = this.requireIdentity();
		return readRun(identity.runId);
	}

	pause() {
		const identity = this.requireIdentity();
		if (identity.isWorker) throw new Error("Only the swarm root can pause the swarm");
		const run = readRun(identity.runId);
		if (run.rootNodeId !== identity.nodeId) throw new Error("Only the swarm root can pause the swarm");
		if (run.status === "stopped") throw new Error("Cannot pause a stopped swarm");
		this.cancelCompactionWake();
		const paused = updateRun(run.runId, (current) => { current.status = "paused"; });
		this.noteActivity({ kind: "pause", source: "state", nodeId: identity.nodeId });
		return paused;
	}

	resumableRuns() {
		const directory = join(stateRoot(), "runs");
		if (!existsSync(directory)) return [];
		return readdirSync(directory).flatMap((name) => {
			try {
				const run = readRun(name);
				return run.status === "active" || run.status === "paused" ? [run] : [];
			} catch {
				return [];
			}
		});
	}

	async resume(requestedRunId: string | undefined, ctx: ExtensionContext) {
		this.clearCompactionRecovery();
		const requested = requestedRunId?.trim() || undefined;
		let run: RunRecord;
		const attachedIdentity = this.identity ? this.requireIdentity() : null;
		if (attachedIdentity) {
			if (attachedIdentity.isWorker) throw new Error("Only the swarm root can resume the swarm");
			run = readRun(attachedIdentity.runId);
			if (requested && requested !== run.runId) throw new Error(`This session is attached to ${run.runId}, not ${requested}`);
		} else {
			const candidates = requested ? [readRun(requested)] : this.resumableRuns();
			if (candidates.length === 0) throw new Error("No resumable swarm runs found");
			if (candidates.length > 1) throw new Error(`Multiple resumable swarms found; specify one: ${candidates.map((candidate) => candidate.runId).join(", ")}`);
			run = candidates[0]!;
		}
		if (run.status === "stopped") throw new Error(`Swarm ${run.runId} is stopped and cannot be resumed`);
		if (!attachedIdentity && run.status === "active" && rootOwnerAppearsLive(run)) {
			throw new Error(`Swarm ${run.runId} still has a live root session (${run.rootSessionId}); pause or stop that session before resuming elsewhere`);
		}
		const root = readNode(run.runId, run.rootNodeId);
		if (isTerminal(root.status)) throw new Error(`Swarm ${run.runId} has a terminal root`);
		const sessionId = ctx.sessionManager.getSessionId();
		const existing = readJson<{ runId?: string; nodeId?: string }>(sessionIndexFile(sessionId));
		if (existing && (existing.runId !== run.runId || existing.nodeId !== root.nodeId)) throw new Error(`This Pi session already belongs to swarm ${existing.runId}`);
		const previousSessionId = run.rootSessionId;
		const previousOwnerToken = run.rootOwnerToken;
		const rootOwnerToken = attachedIdentity?.rootOwnerToken ?? newId("owner");
		run = updateRun(run.runId, (current) => {
			if (!attachedIdentity) {
				if (current.rootOwnerToken !== previousOwnerToken) throw new RootOwnershipError(`Swarm ${current.runId} root ownership changed while resuming`);
				if (current.status === "active" && rootOwnerAppearsLive(current)) throw new Error(`Swarm ${current.runId} acquired a live root while resuming`);
			}
			current.rootSessionId = sessionId;
			current.rootOwnerToken = rootOwnerToken;
			current.rootOwnerPid = process.pid;
			current.rootHeartbeatAt = now();
			current.status = "active";
		});
		if (previousSessionId !== sessionId) {
			const oldIndexPath = sessionIndexFile(previousSessionId);
			withLock(sessionIndexLock(previousSessionId), () => {
				const oldIndex = readJson<{ runId?: string; nodeId?: string }>(oldIndexPath);
				if (oldIndex?.runId === run.runId && oldIndex.nodeId === root.nodeId) rmSync(oldIndexPath, { force: true });
			});
		}
		withLock(sessionIndexLock(sessionId), () => writeJson(sessionIndexFile(sessionId), { schemaVersion: SCHEMA_VERSION, sessionId, runId: run.runId, nodeId: root.nodeId, updatedAt: now() }));
		this.identity = { runId: run.runId, nodeId: root.nodeId, isWorker: false, rootOwnerToken };
		this.lastRootHeartbeatAt = run.rootHeartbeatAt;
		this.context = ctx;
		this.stopped = false;
		this.startPolling();
		this.refreshStatus(ctx);
		this.noteActivity({ kind: "resume", source: "state", nodeId: root.nodeId, runId: run.runId });
		const repaired = await this.repairDeadWorkers(readRun(run.runId), ctx);
		if (repaired.length > 0) this.noteActivity({ kind: "repair", source: "resume", nodeId: root.nodeId, childIds: repaired });
		return readRun(run.runId);
	}

	private sessionName(ctx: ExtensionContext) {
		const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & { getSessionName?: () => string };
		return manager.getSessionName?.() ?? null;
	}

	async spawn(task: string, dirtyMode: DirtyMode | undefined, ctx: ExtensionContext): Promise<SpawnDetails> {
		const identity = this.requireIdentity();
		const parent = readNode(identity.runId, identity.nodeId);
		const run = readRun(identity.runId);
		if (run.status === "paused") throw new Error(`Swarm ${run.runId} is paused; resume it before spawning a worker`);
		if (isTerminal(parent.status)) throw new Error(`Cannot spawn from terminal node ${parent.nodeId}`);
		const depth = this.depth(run, parent);
		if (depth >= run.config.maxDepth) throw new Error(`Maximum swarm depth ${run.config.maxDepth} reached; agents cannot change this limit`);
		const taskText = task.trim();
		if (!taskText) throw new Error("task is required");
		if (Buffer.byteLength(taskText, "utf8") > run.config.maxInlineBytes) throw new Error(`task exceeds the ${run.config.maxInlineBytes}-byte inline limit`);
		const childId = newId("node");
		const prepared = prepareWorktree(run, parent, childId, dirtyMode);
		const child: NodeRecord = {
			schemaVersion: SCHEMA_VERSION,
			runId: run.runId,
			nodeId: childId,
			parentId: parent.nodeId,
			childIds: [],
			role: "worker",
			task: taskText,
			status: "starting",
			version: 1,
			createdAt: now(),
			updatedAt: now(),
			sessionId: null,
			sessionName: `swarm-${childId.slice(-8)}`,
			cwd: prepared.cwd,
			worktreePath: prepared.worktreePath,
			branch: prepared.branch,
			sharedDirectory: prepared.sharedDirectory,
			tmuxSession: run.tmuxSession,
			tmuxWindow: `w-${childId.slice(-8)}`,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			thinking: ctx.thinkingLevel,
			result: null,
			resultMessageId: null,
			review: null,
			reviewMessageId: null,
			failure: null,
			readyAt: null,
			cleanedAt: null,
		};
		try {
			writeJson(nodeFile(run.runId, childId), child);
			updateNode(run.runId, parent.nodeId, (current) => {
				if (current.status !== "running" && current.status !== "rework") throw new Error(`Cannot attach a child while ${current.nodeId} is ${current.status}`);
				current.childIds.push(childId);
			});
			this.launchWorker(run, child, ctx);
			if (!(await this.waitForReady(run.runId, childId, run.config.startupTimeoutMs))) {
				const diagnostics = this.observeNode(child);
				const timedOut = readNode(run.runId, childId);
				transitionNode(run.runId, childId, "failed", (current) => { current.failure = `Worker readiness timed out after ${run.config.startupTimeoutMs}ms\n${diagnostics}`; }, timedOut.version);
				this.killWindow(child);
				throw new Error(`Worker ${childId} did not become ready within ${run.config.startupTimeoutMs}ms\n${diagnostics}`);
			}
			this.noteActivity({ kind: "spawn", source: "spawn", nodeId: childId });
			return { node: readNode(run.runId, childId), worktreeMode: prepared.mode };
		} catch (error) {
			const current = readJson<NodeRecord>(nodeFile(run.runId, childId));
			const attached = readNode(run.runId, parent.nodeId).childIds.includes(childId);
			if (!attached && prepared.worktreePath && prepared.branch) {
				const preparedGit = gitInfo(prepared.worktreePath);
				const gitCwd = preparedGit?.root ?? prepared.worktreePath;
				try { gitRun(gitCwd, ["worktree", "remove", "--force", prepared.worktreePath], true); } catch {}
				try { gitRun(gitCwd, ["branch", "-D", prepared.branch], true); } catch {}
			}
			if (!attached) rmSync(nodeFile(run.runId, childId), { force: true });
			else if (current && !isTerminal(current.status)) {
				try { transitionNode(run.runId, childId, "failed", (node) => { node.failure = error instanceof Error ? error.message : String(error); }, current.version); } catch {}
			}
			throw error;
		}
	}

	send(targetId: string, kind: MessageKind, body: string) {
		const identity = this.requireIdentity();
		const run = readRun(identity.runId);
		const sender = readNode(identity.runId, identity.nodeId);
		const target = readNode(identity.runId, targetId);
		if (!this.areDirectRelatives(sender, target)) throw new Error("Swarm messages are limited to direct parent/child nodes");
		if (kind === "instruction" && target.parentId !== sender.nodeId) throw new Error("Only a direct parent may send authoritative instructions");
		return this.createMessage(run, sender, target, kind, body);
	}

	complete(result: string) {
		const identity = this.requireIdentity();
		if (!identity.isWorker) throw new Error("Only a worker can submit a result");
		if (!result.trim()) throw new Error("result is required");
		const run = readRun(identity.runId);
		const node = readNode(run.runId, identity.nodeId);
		if (node.status !== "running" && node.status !== "rework") throw new Error(`Cannot complete worker in ${node.status} state`);
		const parent = node.parentId ? readNode(run.runId, node.parentId) : null;
		if (!parent) throw new Error("Worker has no parent for result delivery");
		const messageId = newId("msg");
		const payload = payloadFor(run, messageId, result);
		const resultRecord: ResultRecord = { text: payload.body, ...(payload.artifactPath ? { artifactPath: payload.artifactPath } : {}), submittedAt: now() };
		transitionNode(run.runId, node.nodeId, "awaiting-review", (current) => {
			const activeDescendants = this.descendants(run, current).filter((descendant) => !isTerminal(descendant.status));
			if (activeDescendants.length > 0) throw new Error(`Cannot complete ${current.nodeId} while descendants are active: ${activeDescendants.map((descendant) => descendant.nodeId).join(", ")}`);
			current.result = resultRecord;
			current.resultMessageId = messageId;
			current.review = null;
			current.reviewMessageId = null;
		}, node.version);
		return this.createMessage(run, node, parent, "result", payload.body, messageId, payload.artifactPath);
	}

	review(targetId: string, action: ReviewRecord["action"], feedback?: string) {
		const identity = this.requireIdentity();
		const run = readRun(identity.runId);
		const reviewer = readNode(run.runId, identity.nodeId);
		const target = readNode(run.runId, targetId);
		if (target.parentId !== reviewer.nodeId) throw new Error("Only a direct parent may review a child result");
		if (target.status !== "awaiting-review") throw new Error(`Node ${targetId} is not awaiting review`);
		if (action !== "request-changes") {
			const activeDescendants = this.descendants(run, target).filter((descendant) => !isTerminal(descendant.status));
			if (activeDescendants.length > 0) throw new Error(`Cannot ${action} ${target.nodeId} while descendants are active: ${activeDescendants.map((descendant) => descendant.nodeId).join(", ")}`);
		}
		const review: ReviewRecord = { action, ...(feedback ? { feedback } : {}), updatedAt: now() };
		if (action === "request-changes") {
			const reviewMessageId = newId("msg");
			transitionNode(run.runId, target.nodeId, "rework", (current) => { current.review = review; current.reviewMessageId = reviewMessageId; }, target.version);
			this.createMessage(run, reviewer, target, "instruction", feedback?.trim() || "Please revise the result and submit it again with swarm_complete.", reviewMessageId);
		} else {
			transitionNode(run.runId, target.nodeId, action === "accept" ? "completed" : "rejected", (current) => { current.review = review; current.reviewMessageId = null; }, target.version);
			this.killWindow(target);
		}
		return readNode(run.runId, target.nodeId);
	}

	stop(targetId: string) {
		const identity = this.requireIdentity();
		const run = readRun(identity.runId);
		const current = readNode(run.runId, identity.nodeId);
		const target = readNode(run.runId, targetId);
		if (target.nodeId === run.rootNodeId) throw new Error("The root session cannot stop itself with swarm_stop");
		const isRootEmergency = current.nodeId === run.rootNodeId;
		if (isRootEmergency && !visibleNodes(run, current).some((node) => node.nodeId === target.nodeId)) throw new Error("Root emergency stop is limited to descendants in the current tree");
		if (!isRootEmergency && target.parentId !== current.nodeId) throw new Error("Only a direct parent may stop a child");
		const descendants = this.descendants(run, target);
		for (const node of [...descendants.reverse(), target]) {
			const latest = readNode(run.runId, node.nodeId);
			if (!isTerminal(latest.status)) transitionNode(run.runId, node.nodeId, "stopped", (item) => { item.failure = "Stopped by swarm parent"; }, latest.version);
			this.killWindow(latest);
		}
		return readNode(run.runId, target.nodeId);
	}

	async restart(targetId: string, ctx: ExtensionContext) {
		const identity = this.requireIdentity();
		const run = readRun(identity.runId);
		if (run.status === "paused") throw new Error(`Swarm ${run.runId} is paused; resume it before restarting a worker`);
		const current = readNode(run.runId, identity.nodeId);
		const target = readNode(run.runId, targetId);
		if (target.nodeId === run.rootNodeId) throw new Error("The root session cannot restart itself");
		if (target.role !== "worker") throw new Error(`Cannot restart ${target.nodeId}; only workers can be restarted`);
		const isRoot = current.nodeId === run.rootNodeId;
		if (isRoot && !visibleNodes(run, current).some((node) => node.nodeId === target.nodeId)) throw new Error("Root restart is limited to descendants in the current tree");
		if (!isRoot && target.parentId !== current.nodeId) throw new Error("Only a direct parent may restart a child");
		if (target.status !== "failed" && target.status !== "stopped") throw new Error(`Cannot restart worker in ${target.status} state`);
		if (target.cleanedAt) throw new Error(`Cannot restart ${target.nodeId}; its worktree was cleaned`);
		if (target.worktreePath && !existsSync(target.worktreePath)) throw new Error(`Cannot restart ${target.nodeId}; its worktree is missing`);
		this.killWindow(target);
		transitionNode(run.runId, target.nodeId, "starting", (node) => {
			node.failure = null;
			node.readyAt = null;
			node.sessionId = null;
		}, target.version);
		return this.relaunchWorker(run, readNode(run.runId, target.nodeId), ctx, "restart");
	}

	cleanup(targetId?: string) {
		const identity = this.requireIdentity();
		const run = readRun(identity.runId);
		const current = readNode(run.runId, identity.nodeId);
		if (!targetId) {
			const cleaned: NodeRecord[] = [];
			for (const node of visibleNodes(run, current)) {
				if (node.nodeId === run.rootNodeId || !this.canCleanup(run, current, node)) continue;
				if (!isTerminal(node.status) || node.sharedDirectory || !node.worktreePath || node.cleanedAt) continue;
				cleaned.push(this.cleanupNode(run, node));
			}
			return { nodes: cleaned };
		}
		const target = readNode(run.runId, targetId);
		if (target.nodeId === run.rootNodeId) throw new Error("The root has no isolated worktree to clean");
		if (current.nodeId !== run.rootNodeId && target.parentId !== current.nodeId) throw new Error("Only the direct parent or root may clean a child worktree");
		if (!isTerminal(target.status)) throw new Error(`Cannot clean a non-terminal node: ${target.status}`);
		if (target.sharedDirectory || target.cleanedAt || !target.worktreePath) return target;
		return this.cleanupNode(run, target);
	}

	private canCleanup(run: RunRecord, current: NodeRecord, target: NodeRecord) {
		if (target.nodeId === run.rootNodeId) return false;
		return current.nodeId === run.rootNodeId || target.parentId === current.nodeId;
	}

	private cleanupNode(run: RunRecord, target: NodeRecord) {
		if (!existsSync(target.worktreePath!)) return updateNodeMetadata(run.runId, target.nodeId, (node) => { node.cleanedAt = now(); });
		removeWorktree(target);
		return updateNodeMetadata(run.runId, target.nodeId, (node) => { node.cleanedAt = now(); });
	}

	/**
	 * Stop every worker in the current root's run and kill its tmux session.
	 * The root remains active so it can inspect or clear the durable run state.
	 */
	kill() {
		const identity = this.requireIdentity();
		if (identity.isWorker) throw new Error("Only the swarm root can kill the entire swarm");
		const run = readRun(identity.runId);
		const root = readNode(run.runId, run.rootNodeId);
		if (identity.nodeId !== root.nodeId) throw new Error("Only the swarm root can kill the entire swarm");
		const stoppedNodeIds: string[] = [];
		for (const node of [...this.descendants(run, root).reverse()]) {
			const latest = readNode(run.runId, node.nodeId);
			if (!isTerminal(latest.status)) {
				transitionNode(run.runId, latest.nodeId, "stopped", (current) => { current.failure = "Stopped by swarm root"; }, latest.version);
				stoppedNodeIds.push(latest.nodeId);
			}
		}
		const killed = runTmux(["kill-session", "-t", run.tmuxSession], true).ok;
		this.noteActivity({ kind: "kill", source: "state", nodeId: root.nodeId });
		return { runId: run.runId, tmuxSession: run.tmuxSession, stoppedNodeIds, killed };
	}

	/**
	 * Kill the run, remove clean generated worktrees, and delete its durable
	 * state. Dirty worktrees are deliberately refused so clearing a stale swarm
	 * cannot silently discard an uncommitted worker handoff.
	 */
	clear(): ClearDetails {
		const identity = this.requireIdentity();
		if (identity.isWorker) throw new Error("Only the swarm root can clear the entire swarm");
		const run = readRun(identity.runId);
		const root = readNode(run.runId, run.rootNodeId);
		if (identity.nodeId !== root.nodeId) throw new Error("Only the swarm root can clear the entire swarm");
		const workers = this.descendants(run, root);
		const worktreeNodes = workers.filter((node) => node.worktreePath && !node.cleanedAt);
		const blockers: string[] = [];
		for (const node of worktreeNodes) {
			if (!existsSync(node.worktreePath!)) continue;
			const info = gitInfo(node.worktreePath!);
			if (!info) blockers.push(`${node.nodeId}: its worktree is no longer a Git worktree`);
			else if (isDirty(info.status)) blockers.push(`${node.nodeId}: its worktree is dirty; commit or clean it first`);
		}
		if (blockers.length > 0) throw new Error(`Cannot clear swarm ${run.runId}; resolve worktrees first:\n${blockers.join("\n")}`);

		const killed = this.kill();
		this.clearCompactionRecovery();
		const removedWorktrees: string[] = [];
		for (const node of worktreeNodes) {
			if (!existsSync(node.worktreePath!)) {
				updateNodeMetadata(run.runId, node.nodeId, (current) => { current.cleanedAt = now(); });
				continue;
			}
			const info = gitInfo(node.worktreePath!);
			if (!info || isDirty(info.status)) throw new Error(`Unable to clear worker ${node.nodeId} worktree safely`);
			gitRun(info.root, ["worktree", "remove", node.worktreePath!]);
			updateNodeMetadata(run.runId, node.nodeId, (current) => { current.cleanedAt = now(); });
			removedWorktrees.push(node.worktreePath!);
		}
		const remaining = worktreeNodes.filter((node) => node.worktreePath && existsSync(node.worktreePath));
		if (remaining.length > 0) throw new Error(`Unable to clear worker worktrees: ${remaining.map((node) => node.nodeId).join(", ")}`);

		const index = readJson<{ runId?: string; nodeId?: string }>(sessionIndexFile(run.rootSessionId));
		if (index?.runId === run.runId && index.nodeId === root.nodeId) rmSync(sessionIndexFile(run.rootSessionId), { force: true });
		rmSync(runPath(run.runId), { recursive: true, force: true });
		this.stopped = true;
		this.agentRunning = false;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		this.identity = null;
		this.context = null;
		this.noteActivity({ kind: "clear", source: "state", nodeId: root.nodeId, runId: run.runId });
		return { runId: run.runId, tmuxSession: killed.tmuxSession, stoppedNodeIds: killed.stoppedNodeIds, removedWorktrees };
	}

	tree() {
		const identity = this.requireIdentity();
		const run = readRun(identity.runId);
		const current = readNode(run.runId, identity.nodeId);
		const nodes = visibleNodes(run, current);
		const text = treeText(nodes);
		return { nodes, rootId: run.rootNodeId, text: run.status === "paused" ? `Swarm ${run.runId} is paused. Resume with /swarm:resume ${run.runId}.\n\n${text}` : text };
	}

	async openTree(ctx: ExtensionContext) {
		const tree = this.tree();
		let unsubscribe: (() => void) | undefined;
		let liveRefreshTimer: ReturnType<typeof setInterval> | undefined;
		const readLiveOutput: SwarmTreeOutputReader = (node) => {
			if (!node.tmuxSession || !node.tmuxWindow) return null;
			try {
				return capturePane(node.tmuxSession, node.tmuxWindow, LIVE_PANE_LINES);
			} catch (error) {
				return `Live pane unavailable: ${error instanceof Error ? error.message : String(error)}`;
			}
		};
		try {
			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				const view = new SwarmTreeView(tui, theme, {
					nodes: tree.nodes,
					rootId: tree.rootId,
				}, done, () => {
					const latest = this.tree();
					return { nodes: latest.nodes, rootId: latest.rootId };
				}, readLiveOutput);
				unsubscribe = this.pi.events.on(AGENT_SWARM_ACTIVITY_EVENT, () => tui.requestRender());
				liveRefreshTimer = setInterval(() => tui.requestRender(), LIVE_REFRESH_INTERVAL_MS);
				return view;
			}, {
				overlay: true,
				overlayOptions: {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
			});
		} finally {
			unsubscribe?.();
			if (liveRefreshTimer) clearInterval(liveRefreshTimer);
		}
	}

	observe(targetId: string | undefined, lines: number | undefined) {
		const identity = this.requireIdentity();
		const run = readRun(identity.runId);
		const current = readNode(run.runId, identity.nodeId);
		const target = readNode(run.runId, targetId ?? current.nodeId);
		if (!visibleNodes(run, current).some((node) => node.nodeId === target.nodeId)) throw new Error("That node is outside your observation scope");
		if (!target.tmuxSession || !target.tmuxWindow) throw new Error("That node has no tmux worker pane");
		const output = capturePane(target.tmuxSession, target.tmuxWindow, Math.max(1, Math.min(MAX_PANE_LINES, Math.floor(lines ?? 80))));
		return { node: target, output };
	}

	task() {
		return this.getCurrentNode().task;
	}

	writeOutputArtifact(text: string) {
		const run = this.getRun();
		const artifactPath = writeArtifact(run, newId("artifact"), text);
		return join(runPath(run.runId), artifactPath);
	}

	refreshStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!this.identity) {
			ctx.ui.setStatus("agent-swarm", undefined);
			return;
		}
		const tree = this.tree();
		const active = tree.nodes.filter((node) => !isTerminal(node.status)).length;
		const waiting = tree.nodes.filter((node) => node.status === "awaiting-review").length;
		const run = readRun(this.identity.runId);
		const state = run.status === "paused" ? "paused" : `${active} active${waiting ? ` ${waiting} review` : ""}`;
		ctx.ui.setStatus("agent-swarm", ctx.ui.theme.fg("dim", `swarm ${this.identity.nodeId.slice(-8)} ${state}`));
	}

	private startPolling() {
		if (this.pollTimer || !this.identity) return;
		const run = readRun(this.identity.runId);
		this.pollTimer = setInterval(() => {
			if (this.stopped) return;
			try {
				this.assertRootOwnership(this.identity!);
				if (readRun(this.identity!.runId).status === "paused") {
					if (this.context) this.refreshStatus(this.context);
					return;
				}
				this.refreshRootHeartbeat();
				this.reconcileOutbox();
				this.pollInbox();
				this.refreshLiveness();
				if (this.context) this.refreshStatus(this.context);
			} catch (error) {
				if (error instanceof RootOwnershipError) {
					if (this.pollTimer) clearInterval(this.pollTimer);
					this.pollTimer = undefined;
					this.context?.ui.setStatus("agent-swarm", undefined);
				}
				this.context?.ui.notify(error instanceof Error ? `agent-swarm: ${error.message}` : `agent-swarm: ${String(error)}`, "error");
			}
		}, run.config.pollIntervalMs);
	}

	private reconcileOutbox() {
		if (!this.identity?.isWorker) return;
		const run = readRun(this.identity.runId);
		const node = readNode(run.runId, this.identity.nodeId);
		const parent = node.parentId ? readNode(run.runId, node.parentId) : null;
		if (!parent) return;
		if (node.status === "awaiting-review" && node.result && node.resultMessageId) {
			const path = messageFile(run.runId, parent.nodeId, node.resultMessageId);
			if (!existsSync(path)) this.createMessage(run, node, parent, "result", node.result.text, node.resultMessageId, node.result.artifactPath);
			else this.ensureDelivery(run, parent.nodeId, node.resultMessageId);
		}
		if (node.status === "rework" && node.review?.action === "request-changes" && node.reviewMessageId) {
			const body = node.review.feedback?.trim() || "Please revise the result and submit it again with swarm_complete.";
			const path = messageFile(run.runId, node.nodeId, node.reviewMessageId);
			if (!existsSync(path)) this.createMessage(run, parent, node, "instruction", body, node.reviewMessageId);
			else this.ensureDelivery(run, node.nodeId, node.reviewMessageId);
		}
	}

	private pollInbox() {
		if (!this.identity) return;
		const run = readRun(this.identity.runId);
		for (const path of messageFiles(run.runId, this.identity.nodeId)) {
			const message = readJson<MessageRecord>(path);
			if (!message || message.runId !== run.runId) continue;
			const delivery = readJson<DeliveryRecord>(deliveryFile(run.runId, this.identity.nodeId, message.messageId));
			if (delivery?.state === "acked") continue;
			const claimed = withLock(deliveryLock(run.runId, this.identity.nodeId, message.messageId), () => {
				const current = readJson<DeliveryRecord>(deliveryFile(run.runId, this.identity!.nodeId, message.messageId)) ?? { schemaVersion: SCHEMA_VERSION, messageId: message.messageId, state: "pending" as const, claimedAt: null, claimedBy: null, ackedAt: null };
				if (current.state === "acked") return false;
				if (current.state === "claimed" && current.claimedAt && now() - current.claimedAt < CLAIM_TIMEOUT_MS && current.claimedBy !== `${process.pid}`) return false;
				writeJson(deliveryFile(run.runId, this.identity!.nodeId, message.messageId), { ...current, state: "claimed", claimedAt: now(), claimedBy: `${process.pid}` } satisfies DeliveryRecord);
				return true;
			});
			if (!claimed) continue;
			try {
				if (!this.deliveredMessages.has(message.messageId)) {
					this.pi.sendMessage<MessageDetails>({
						customType: "agent-swarm-inbox",
						content: formatMessage(message),
						display: true,
						details: {
							messageId: message.messageId,
							fromNodeId: message.fromNodeId,
							toNodeId: message.toNodeId,
							kind: message.kind,
							body: message.body,
						},
					}, { deliverAs: "steer", triggerTurn: true });
					this.deliveredMessages.add(message.messageId);
				}
				writeJson(deliveryFile(run.runId, this.identity.nodeId, message.messageId), { schemaVersion: SCHEMA_VERSION, messageId: message.messageId, state: "acked", claimedAt: now(), claimedBy: `${process.pid}`, ackedAt: now() } satisfies DeliveryRecord);
				this.noteActivity({ kind: message.kind, source: "inbox", messageId: message.messageId, nodeId: this.identity.nodeId });
			} catch (error) {
				writeJson(deliveryFile(run.runId, this.identity.nodeId, message.messageId), { schemaVersion: SCHEMA_VERSION, messageId: message.messageId, state: "pending", claimedAt: null, claimedBy: null, ackedAt: null } satisfies DeliveryRecord);
				throw error;
			}
		}
	}

	private refreshLiveness() {
		if (!this.identity) return;
		const run = readRun(this.identity.runId);
		const current = readNode(run.runId, this.identity.nodeId);
		for (const node of visibleNodes(run, current)) {
			if (node.nodeId === current.nodeId || isTerminal(node.status) || !node.tmuxSession || !node.tmuxWindow) continue;
			if (!tmuxWindowAlive(node.tmuxSession, node.tmuxWindow)) {
				try { transitionNode(run.runId, node.nodeId, "failed", (item) => { item.failure = "Worker tmux window disappeared unexpectedly"; }, node.version); } catch {}
			}
			const latest = readNode(run.runId, node.nodeId);
			const previous = this.knownStatuses.get(node.nodeId);
			if (previous !== latest.status) {
				this.knownStatuses.set(node.nodeId, latest.status);
				this.noteActivity({ kind: "state", source: "state", nodeId: node.nodeId, status: latest.status });
			}
		}
	}

	private noteActivity(value: Record<string, unknown>) {
		this.pi.events.emit(AGENT_SWARM_ACTIVITY_EVENT, value);
	}

	private cancelCompactionWake() {
		this.compactionWakeTimerGeneration++;
		this.cancelCompactionWakeTimer?.();
		this.cancelCompactionWakeTimer = undefined;
	}

	private clearCompactionRecovery() {
		this.cancelCompactionWake();
		this.interruptedRun = undefined;
		this.armedCompaction = undefined;
	}

	private wakeParentForMonitoring(ctx: ExtensionContext, force = false) {
		if (this.stopped || !this.identity || !this.context || typeof ctx.isIdle !== "function" || typeof ctx.hasPendingMessages !== "function" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		try { this.assertRootOwnership(this.identity); } catch { return; }
		const run = readRun(this.identity.runId);
		if (run.status !== "active") return;
		const current = readNode(run.runId, this.identity.nodeId);
		if (isTerminal(current.status)) return;
		const activeChildren = childNodes(run.runId, current).filter((child) => !isTerminal(child.status));
		if (activeChildren.length === 0) {
			this.monitorWokenGeneration = -1;
			this.monitorWokenChildren = "";
			return;
		}
		const childKey = activeChildren.map((child) => child.nodeId).sort().join("|");
		if (!force && this.monitorWokenGeneration === this.activityGeneration && this.monitorWokenChildren === childKey) return;
		const generation = this.activityGeneration;
		const children = activeChildren.map((child) => `${child.nodeId} (${child.status})`).join(", ");
		const content = `${MONITOR_PROMPT_PREFIX}\n${children.length > 0 ? `Active children: ${children}. ` : ""}Use swarm_tree to inspect their progress and continue monitoring until every child reaches a terminal state. Review child results when they arrive; do not end this session while children are active.`;
		this.monitorWokenGeneration = generation;
		this.monitorWokenChildren = childKey;
		try {
			this.pi.sendMessage({
				customType: "agent-swarm-monitor",
				content,
				display: false,
				details: { generation, nodeId: current.nodeId, childIds: activeChildren.map((child) => child.nodeId), ...(force ? { recovery: "compaction" } : {}) },
			}, { triggerTurn: true });
			this.monitorWakeCount++;
		} catch {
			// Allow a later settled/activity event to retry if the session was
			// unable to accept the wake-up message. Do not rethrow from a lifecycle
			// hook or a polling event: a transient wake-up failure must not take
			// down the parent Pi session.
			if (this.monitorWokenGeneration === generation) this.monitorWokenGeneration = generation - 1;
			if (this.monitorWokenGeneration === generation - 1) this.monitorWokenChildren = "";
		}
	}

	private createMessage(run: RunRecord, sender: NodeRecord, target: NodeRecord, kind: MessageKind, body: string, requestedId?: string, artifactPath?: string) {
		const messageId = requestedId ?? newId("msg");
		const payload = artifactPath ? { body, artifactPath } : payloadFor(run, messageId, body);
		const message: MessageRecord = {
			schemaVersion: SCHEMA_VERSION,
			messageId,
			runId: run.runId,
			fromNodeId: sender.nodeId,
			toNodeId: target.nodeId,
			kind,
			body: payload.body,
			...(payload.artifactPath ? { artifactPath: payload.artifactPath } : {}),
			createdAt: now(),
		};
		writeJson(messageFile(run.runId, target.nodeId, messageId), message);
		this.ensureDelivery(run, target.nodeId, messageId);
		return message;
	}

	private ensureDelivery(run: RunRecord, targetNodeId: string, messageId: string) {
		if (existsSync(deliveryFile(run.runId, targetNodeId, messageId))) return;
		writeJson(deliveryFile(run.runId, targetNodeId, messageId), { schemaVersion: SCHEMA_VERSION, messageId, state: "pending", claimedAt: null, claimedBy: null, ackedAt: null } satisfies DeliveryRecord);
	}

	private depth(run: RunRecord, node: NodeRecord) {
		let depth = 0;
		let current = node;
		while (current.parentId) {
			depth++;
			current = readNode(run.runId, current.parentId);
		}
		return depth;
	}

	private descendants(run: RunRecord, node: NodeRecord): NodeRecord[] {
		return childNodes(run.runId, node).flatMap((child) => [child, ...this.descendants(run, child)]);
	}

	private areDirectRelatives(left: NodeRecord, right: NodeRecord) {
		return left.parentId === right.nodeId || right.parentId === left.nodeId;
	}

	private async repairDeadWorkers(run: RunRecord, ctx: ExtensionContext) {
		const repaired: string[] = [];
		const root = readNode(run.runId, run.rootNodeId);
		for (const node of this.descendants(run, root)) {
			if (isTerminal(node.status) || node.status === "awaiting-review") continue;
			if (!node.tmuxSession || !node.tmuxWindow) continue;
			if (tmuxWindowAlive(node.tmuxSession, node.tmuxWindow)) continue;
			if (node.cleanedAt || (node.worktreePath && !existsSync(node.worktreePath))) continue;
			const latest = readNode(run.runId, node.nodeId);
			if (isTerminal(latest.status) || latest.status === "awaiting-review") continue;
			try {
				this.killWindow(latest);
				transitionNode(run.runId, latest.nodeId, "starting", (current) => {
					current.failure = null;
					current.readyAt = null;
					current.sessionId = null;
				}, latest.version);
				this.launchWorker(run, readNode(run.runId, latest.nodeId), ctx);
				if (!(await this.waitForReady(run.runId, latest.nodeId, run.config.startupTimeoutMs))) {
					const diagnostics = this.observeNode(readNode(run.runId, latest.nodeId));
					const timedOut = readNode(run.runId, latest.nodeId);
					transitionNode(run.runId, latest.nodeId, "failed", (current) => {
						current.failure = `Worker readiness timed out after ${run.config.startupTimeoutMs}ms\n${diagnostics}`;
					}, timedOut.version);
					this.killWindow(timedOut);
					continue;
				}
				repaired.push(latest.nodeId);
			} catch (error) {
				const failed = readJson<NodeRecord>(nodeFile(run.runId, latest.nodeId));
				if (failed && !isTerminal(failed.status)) {
					try {
						transitionNode(run.runId, failed.nodeId, "failed", (current) => {
							current.failure = error instanceof Error ? error.message : String(error);
						}, failed.version);
					} catch {}
				}
			}
		}
		return repaired;
	}

	private async relaunchWorker(run: RunRecord, node: NodeRecord, ctx: ExtensionContext, kind: "restart" | "repair") {
		try {
			this.launchWorker(run, node, ctx);
			if (!(await this.waitForReady(run.runId, node.nodeId, run.config.startupTimeoutMs))) {
				const diagnostics = this.observeNode(node);
				const timedOut = readNode(run.runId, node.nodeId);
				transitionNode(run.runId, node.nodeId, "failed", (current) => { current.failure = `Worker readiness timed out after ${run.config.startupTimeoutMs}ms\n${diagnostics}`; }, timedOut.version);
				this.killWindow(node);
				throw new Error(`Worker ${node.nodeId} did not become ready within ${run.config.startupTimeoutMs}ms\n${diagnostics}`);
			}
			this.noteActivity({ kind, source: kind, nodeId: node.nodeId });
			return readNode(run.runId, node.nodeId);
		} catch (error) {
			const current = readJson<NodeRecord>(nodeFile(run.runId, node.nodeId));
			if (current && !isTerminal(current.status)) {
				try { transitionNode(run.runId, node.nodeId, "failed", (item) => { item.failure = error instanceof Error ? error.message : String(error); }, current.version); } catch {}
			}
			throw error;
		}
	}

	private launchWorker(run: RunRecord, node: NodeRecord, ctx: ExtensionContext) {
		const piBin = process.env.PI_BIN ?? "pi";
		const sessionId = `swarm-${node.nodeId}`;
		const extensionPaths = [extensionFile, ...run.config.workerExtensions.map((name) => join(extensionsDir, name, "index.ts"))];
		const trustFlag = ctx.isProjectTrusted() ? "--approve" : "--no-approve";
		const args = ["--no-extensions", "--no-skills", trustFlag, "--session-id", sessionId, "--name", node.sessionName ?? node.nodeId];
		if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
		if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
		for (const path of extensionPaths) args.push("--extension", path);
		args.push("Begin your assigned task by reading it with the swarm_task tool.");
		const envArgs = [
			`${WORKER_ENV}=1`,
			`PI_SWARM_RUN_ID=${run.runId}`,
			`PI_SWARM_NODE_ID=${node.nodeId}`,
			`PI_SWARM_PARENT_ID=${node.parentId ?? ""}`,
			`PI_SWARM_HOME=${stateRoot()}`,
			`${CODEX_FAST_MODE_ENV}=${rootFastModeEnabled(ctx) ? "on" : "off"}`,
		];
		if (!tmuxSessionExists(run.tmuxSession)) {
			runTmux(["new-session", "-d", "-s", run.tmuxSession, "-n", node.tmuxWindow ?? node.nodeId, "-c", node.cwd, "env", ...envArgs, piBin, ...args]);
			runTmux(["set-option", "-t", run.tmuxSession, "history-limit", "50000"], true);
			runTmux(["set-option", "-t", run.tmuxSession, "remain-on-exit", "on"], true);
		} else {
			runTmux(["new-window", "-d", "-t", run.tmuxSession, "-n", node.tmuxWindow ?? node.nodeId, "-c", node.cwd, "env", ...envArgs, piBin, ...args]);
		}
	}

	private async waitForReady(runId: string, nodeId: string, timeoutMs: number) {
		const deadline = now() + timeoutMs;
		while (now() < deadline) {
			const node = readNode(runId, nodeId);
			if (node.status === "ready" || node.status === "running") return true;
			if (isTerminal(node.status)) return false;
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
		return false;
	}

	private killWindow(node: NodeRecord) {
		if (node.tmuxSession && node.tmuxWindow && tmuxWindowExists(node.tmuxSession, node.tmuxWindow)) runTmux(["kill-window", "-t", `${node.tmuxSession}:${node.tmuxWindow}`], true);
	}

	private observeNode(node: NodeRecord) {
		if (!node.tmuxSession || !node.tmuxWindow) return "No tmux pane diagnostics available";
		try { return capturePane(node.tmuxSession, node.tmuxWindow, 80); } catch (error) { return error instanceof Error ? error.message : String(error); }
	}
}

export { SwarmRuntime };
