import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { authorizeRequest, visibleNodes } from "./authority.ts";
import { textPreview, unpackPayload } from "./artifacts.ts";
import { assertCleanWorktree, commitResult, createWorktree, git, integrateResult, repositoryInfo } from "./git.ts";
import { assertMacSandboxAvailable } from "./isolation.ts";
import { assertSpawnLimits } from "./lifecycle.ts";
import { workerCost } from "./metrics.ts";
import { acquireRunOwnership } from "./ownership.ts";
import { applyRequest, readRequest } from "./requests.ts";
import { killWindow } from "./tmux.ts";
import { validateConfig } from "./validation.ts";
import { descendants, ensureDir, inboxDir, loadConfig, newId, newToken, nodeFile, outboxDir, queuedRequests, readJson, readNode, readRun, runDir, runFile, sessionFile, stateRoot, tokenFile, updateNode, updateRun, workerHome, workerTmp, writeJson, writeResponse } from "./state.ts";
import { SCHEMA_VERSION, terminalStatuses, workerTimeoutFor, type MessageRecord, type NodeRecord, type RequestKind, type Role, type RunRecord, type SwarmConfig } from "./types.ts";

export interface WorkerProcesses {
	start(run: RunRecord, node: NodeRecord): Promise<void>;
	set(node: NodeRecord, status: "running" | "paused" | "stopped"): Promise<void>;
	status(node: NodeRecord): { pid: number | null; status: string; failure: string | null } | null;
}

export interface LiveDefaults { model: string; thinking: string; fastMode: boolean }

export function makeNode(runId: string, nodeId: string, role: Role, task: string, cwd: string, parentId: string | null): NodeRecord {
	return {
		schemaVersion: SCHEMA_VERSION, runId, nodeId, parentId, childIds: [], role, task, cwd,
		reviewTargetId: null, status: parentId ? "starting" : "running", version: 0,
		createdAt: Date.now(), updatedAt: Date.now(), deadlineAt: null, pausedAt: null,
		sessionId: null, branch: null, baseCommit: null, result: null, review: null, integrationCommit: null,
		failure: null, tmuxSession: null, tmuxWindow: null, pid: null, model: null, thinking: null, sandbox: null, cleanedAt: null,
	};
}

const text = (value: unknown, name: string) => {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be non-empty text`);
	return value;
};

const requestedTimeout = (run: RunRecord, value: unknown, fallback: number) => {
	const timeoutMs = value ?? fallback;
	if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > run.config.maxWorkerTimeoutMs) {
		throw new Error(`timeoutMs must be an integer from 1000 through ${run.config.maxWorkerTimeoutMs}`);
	}
	return timeoutMs as number;
};

export class SwarmRuntime {
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	private constructor(readonly runId: string, private owner: Awaited<ReturnType<typeof acquireRunOwnership>>, private processes: WorkerProcesses, private changed: () => void) {}

	static async create(input: { cwd: string; sessionId: string; objective: string; model?: string; thinking?: string; config?: SwarmConfig }, processes: WorkerProcesses, changed = () => {}) {
		assertMacSandboxAvailable();
		const objective = text(input.objective, "objective");
		const config = input.config ?? loadConfig();
		validateConfig(config);
		const repository = repositoryInfo(input.cwd);
		const requestedRoot = resolve(stateRoot());
		let ancestor = requestedRoot;
		while (!existsSync(ancestor)) ancestor = dirname(ancestor);
		const rootPath = join(realpathSync(ancestor), relative(ancestor, requestedRoot));
		if (rootPath === repository.root || rootPath.startsWith(repository.root + sep)) throw new Error("Swarm state must be outside the repository");
		const previous = readJson<{ runId: string }>(sessionFile(input.sessionId));
		if (previous && existsSync(runFile(previous.runId))) throw new Error("Session already has a swarm; resume or clear it first");
		const runId = newId("run");
		const root = makeNode(runId, newId("node"), "coordinator", objective, repository.root, null);
		root.sessionId = input.sessionId; root.model = input.model ?? null; root.thinking = input.thinking ?? null;
		root.branch = repository.branch; root.baseCommit = repository.head;
		const run: RunRecord = {
			schemaVersion: SCHEMA_VERSION, runId, rootNodeId: root.nodeId, rootSessionId: input.sessionId,
			ownerToken: newToken(), ownerPid: 0, heartbeatAt: 0, cwd: repository.root, gitRoot: repository.root,
			gitCommonDir: repository.commonDir, createdAt: Date.now(), updatedAt: Date.now(), status: "active",
			config, tmuxSession: `pi-swarm-${runId.slice(-12)}`,
		};
		writeJson(runFile(runId), run); writeJson(nodeFile(runId, root.nodeId), root);
		writeJson(sessionFile(input.sessionId), { runId });
		return SwarmRuntime.resume(runId, processes, changed);
	}

	static async resume(runId: string, processes: WorkerProcesses, changed = () => {}) {
		const runtime = new SwarmRuntime(runId, await acquireRunOwnership(runId), processes, changed);
		try {
			if (runtime.run.clearedAt) throw new Error("Swarm has been cleared; generated branches remain available for manual recovery");
			await runtime.poll(); return runtime;
		}
		catch (error) { await runtime.close(); throw error; }
	}

	get run() { return readRun(this.runId); }
	get root() { return readNode(this.runId, this.run.rootNodeId); }
	nodes() {
		return readdirSync(join(runDir(this.runId), "control", "nodes")).filter((file) => /^node_[A-Za-z0-9]+\.json$/.test(file)).map((file) => readNode(this.runId, file.slice(0, -5)));
	}
	private serial<T>(action: () => Promise<T>): Promise<T> {
		const pending = this.queue.then(async () => {
			if (this.closed) throw new Error("Swarm runtime is detached");
			this.owner.assertOwned();
			return action();
		});
		this.queue = pending.catch(() => {});
		return pending;
	}
	private syncDefaults(defaults?: LiveDefaults) {
		if (!defaults) return;
		const root = this.root;
		if (root.model !== defaults.model || root.thinking !== defaults.thinking) updateNode(this.runId, root.nodeId, (node) => {
			node.model = defaults.model;
			node.thinking = defaults.thinking;
		});
		if (this.run.config.fastMode !== defaults.fastMode) updateRun(this.runId, (run) => { run.config.fastMode = defaults.fastMode; });
	}
	private messages(nodeId: string): MessageRecord[] {
		const directory = join(runDir(this.runId), "control", "messages");
		if (!existsSync(directory)) return [];
		return readdirSync(directory).filter((file) => /^msg_[A-Za-z0-9]+\.json$/.test(file)).map((file) => readJson<MessageRecord>(join(directory, file))!).filter((message) => message.toNodeId === nodeId);
	}
	view() {
		return { status: this.run.status, node: this.root, nodes: this.nodes(), messages: this.messages(this.root.nodeId).filter((message) => !message.acknowledgedAt) };
	}
	private snapshot() {
		const nodes = this.nodes();
		for (const node of nodes) {
			if (node.role === "coordinator" || node.cleanedAt) continue;
			const visible = visibleNodes(node, nodes);
			const ids = new Set(visible.map((item) => item.nodeId));
			const preview = (text: string) => textPreview(this.runId, node.nodeId, text, this.run.config.maxInlineBytes);
			const describe = (item: NodeRecord) => ({ ...item, pendingRequests: item.role === "coordinator" || item.cleanedAt ? 0 : queuedRequests(this.runId, item.nodeId).length, task: preview(item.task), result: item.result ? { ...item.result, text: preview(item.result.text), verification: item.result.verification ? preview(item.result.verification) : undefined } : null, childIds: item.childIds.filter((id) => ids.has(id)) });
			writeJson(join(inboxDir(this.runId, node.nodeId), "snapshot.json"), {
				schemaVersion: SCHEMA_VERSION, status: this.run.status, maxInlineBytes: this.run.config.maxInlineBytes, node: describe(node),
				nodes: visible.map(describe),
				messages: this.messages(node.nodeId).filter((message) => !message.acknowledgedAt).map((message) => ({ ...message, body: preview(message.body) })),
			});
		}
		this.changed();
	}
	private send(actor: NodeRecord, target: NodeRecord, body: string, kind: MessageRecord["kind"] = target.parentId === actor.nodeId ? "instruction" : "message") {
		const message: MessageRecord = { schemaVersion: SCHEMA_VERSION, runId: this.runId, messageId: newId("msg"), fromNodeId: actor.nodeId, toNodeId: target.nodeId, kind, body, createdAt: Date.now(), claimedAt: null, acknowledgedAt: null };
		writeJson(join(runDir(this.runId), "control", "messages", `${message.messageId}.json`), message);
		return message;
	}

	act(actorId: string, kind: RequestKind, payload: Record<string, unknown>, defaults?: LiveDefaults) {
		return this.serial(async () => {
			this.syncDefaults(defaults);
			if (actorId !== this.run.rootNodeId) throw new Error("Workers must use their authenticated mailbox");
			const actor = readNode(this.runId, actorId);
			const target = typeof payload.nodeId === "string" ? readNode(this.runId, payload.nodeId) : undefined;
			authorizeRequest(actor, kind, target);
			try { return await this.perform(actor, kind, payload, target); }
			finally { this.snapshot(); }
		});
	}

	private async perform(actor: NodeRecord, kind: RequestKind, payload: Record<string, unknown>, target?: NodeRecord): Promise<unknown> {
		if (this.run.status !== "active" && !["stop", "cleanup", "heartbeat"].includes(kind)) throw new Error(`Swarm is ${this.run.status}`);
		if (kind === "spawn") {
			if (payload.includeDirty !== undefined && typeof payload.includeDirty !== "boolean") throw new Error("includeDirty must be a boolean");
			const timeoutMs = requestedTimeout(this.run, payload.timeoutMs, this.run.config.workerTimeoutMs);
			const role = payload.role ?? "worker";
			if (role !== "manager" && role !== "worker" && role !== "reviewer") throw new Error("Invalid child role");
			assertSpawnLimits(this.run.config, actor, role, this.nodes());
			const task = text(payload.task, "task");
			let revision: string | undefined;
			let reviewTarget: NodeRecord | undefined;
			if (role === "reviewer") {
				reviewTarget = readNode(this.runId, text(payload.reviewTargetId, "reviewTargetId"));
				if (reviewTarget.parentId !== actor.nodeId || reviewTarget.status !== "awaiting-review" || !reviewTarget.result?.commit) throw new Error("Reviewer target must be a direct child awaiting review at a result commit");
				revision = reviewTarget.result.commit;
			}
			const node = makeNode(this.runId, newId("node"), role, task, "", actor.nodeId);
			node.timeoutMs = timeoutMs;
			const worktree = createWorktree(this.run, actor, node.nodeId, payload.includeDirty === true, revision);
			node.cwd = worktree.path; node.branch = worktree.branch; node.baseCommit = worktree.baseCommit;
			const root = this.root;
			node.model = this.run.config.roleModels?.[role] ?? root.model;
			node.thinking = this.run.config.roleThinking?.[role] ?? root.thinking;
			node.reviewTargetId = reviewTarget?.nodeId ?? null;
			node.deadlineAt = Date.now() + workerTimeoutFor(this.run, node);
			for (const path of [inboxDir(this.runId, node.nodeId), outboxDir(this.runId, node.nodeId), workerHome(this.runId, node.nodeId), workerTmp(this.runId, node.nodeId), dirname(tokenFile(this.runId, node.nodeId))]) ensureDir(path);
			writeFileSync(tokenFile(this.runId, node.nodeId), newToken(), { mode: 0o600, flag: "wx" });
			writeJson(nodeFile(this.runId, node.nodeId), node);
			updateNode(this.runId, actor.nodeId, (parent) => { parent.childIds.push(node.nodeId); });
			this.snapshot();
			try { await this.processes.start(this.run, node); }
			catch (error) { updateNode(this.runId, node.nodeId, (child) => { child.status = "failed"; child.failure = String(error); }); throw error; }
			return readNode(this.runId, node.nodeId);
		}
		if (kind === "ready") return updateNode(this.runId, actor.nodeId, (node) => { node.status = "running"; node.sessionId = text(payload.sessionId, "sessionId"); });
		if (kind === "heartbeat") {
			for (const key of ["claimIds", "ackIds"]) {
				if (payload[key] !== undefined && (!Array.isArray(payload[key]) || !(payload[key] as unknown[]).every((id) => typeof id === "string" && /^msg_[A-Za-z0-9]+$/.test(id)))) throw new Error(`${key} must contain message IDs`);
			}
			updateNode(this.runId, actor.nodeId, (node) => { node.lastHeartbeatAt = Date.now(); });
			for (const message of this.messages(actor.nodeId)) {
				if (Array.isArray(payload.claimIds) && payload.claimIds.includes(message.messageId)) message.claimedAt ??= Date.now();
				if (Array.isArray(payload.ackIds) && payload.ackIds.includes(message.messageId) && message.claimedAt) message.acknowledgedAt ??= Date.now();
				writeJson(join(runDir(this.runId), "control", "messages", `${message.messageId}.json`), message);
			}
			return { alive: true };
		}
		if (kind === "send") return this.send(actor, target!, text(payload.body, "body"));
		if (kind === "complete") {
			if (payload.verification !== undefined && typeof payload.verification !== "string") throw new Error("verification must be text");
			if (descendants(this.runId, actor).some((node) => !terminalStatuses.has(node.status))) throw new Error("Cannot complete while descendants are active or awaiting review");
			const body = text(payload.text, "text");
			await this.processes.set(actor, "paused");
			try {
				const commit = actor.role === "reviewer" ? null : commitResult(actor, `Complete swarm task ${actor.nodeId}`);
				const result = { text: body, commit, verification: typeof payload.verification === "string" ? payload.verification : undefined, submittedAt: Date.now() };
				updateNode(this.runId, actor.nodeId, (node) => { node.result = result; node.status = "awaiting-review"; });
				this.send(actor, readNode(this.runId, actor.parentId!), body, "result");
				return result;
			} catch (error) {
				await this.processes.set(actor, "running");
				throw error;
			}
		}
		if (kind === "review") {
			if (payload.feedback !== undefined && typeof payload.feedback !== "string") throw new Error("feedback must be text");
			if (target!.status !== "awaiting-review") throw new Error("Target is not awaiting review");
			const action = payload.action;
			if (action !== "accept" && action !== "request-changes" && action !== "reject") throw new Error("Invalid review action");
			const feedback = typeof payload.feedback === "string" ? payload.feedback : undefined;
			await this.processes.set(target!, action === "request-changes" ? "running" : "stopped");
			const reviewed = updateNode(this.runId, target!.nodeId, (node) => {
				node.review = { action, feedback, updatedAt: Date.now() };
				node.status = action === "accept" ? "completed" : action === "reject" ? "rejected" : "rework";
			});
			if (action === "request-changes") this.send(actor, reviewed, feedback ?? "Revise the result and submit again.");
			return reviewed;
		}
		if (kind === "integrate") {
			if (actor.role !== "coordinator") await this.processes.set(actor, "paused");
			try {
				const commit = integrateResult(this.run, actor, target!);
				updateNode(this.runId, target!.nodeId, (node) => { node.integrationCommit = commit; });
				return { commit };
			} finally { if (actor.role !== "coordinator") await this.processes.set(actor, "running"); }
		}
		if (kind === "stop") {
			const targets = [target!, ...descendants(this.runId, target!)];
			if (actor.role !== "coordinator" && targets.slice(1).some((node) => !terminalStatuses.has(node.status))) throw new Error("Stop the child's descendants through their direct parent first");
			for (const node of targets.reverse()) {
				if (terminalStatuses.has(node.status)) continue;
				await this.processes.set(node, "stopped");
				updateNode(this.runId, node.nodeId, (current) => { current.status = "stopped"; });
			}
			return { stopped: target!.nodeId };
		}
		if (kind === "restart") {
			if (target!.cleanedAt || !["failed", "stopped"].includes(target!.status)) throw new Error("Only retained failed or stopped nodes can restart");
			const timeoutMs = requestedTimeout(this.run, payload.timeoutMs, workerTimeoutFor(this.run, target!));
			assertSpawnLimits(this.run.config, actor, target!.role, this.nodes());
			await this.processes.set(target!, "stopped");
			writeFileSync(tokenFile(this.runId, target!.nodeId), newToken(), { mode: 0o600 });
			const node = updateNode(this.runId, target!.nodeId, (current) => {
				current.status = "starting";
				current.failure = null;
				current.timeoutMs = timeoutMs;
				current.deadlineAt = Date.now() + timeoutMs;
			});
			try { await this.processes.start(this.run, node); }
			catch (error) { updateNode(this.runId, node.nodeId, (current) => { current.status = "failed"; current.failure = String(error); }); throw error; }
			return node;
		}
		if (kind === "cleanup") {
			if (!terminalStatuses.has(target!.status)) throw new Error("Cleanup requires a terminal node");
			if (target!.cleanedAt) return target;
			assertCleanWorktree(target!);
			await this.processes.set(target!, "stopped");
			const estimatedCost = workerCost(target!);
			git(this.run.gitRoot, ["worktree", "remove", target!.cwd]);
			if (target!.tmuxSession && target!.tmuxWindow) killWindow(target!.tmuxSession, target!.tmuxWindow);
			rmSync(workerHome(this.runId, target!.nodeId), { recursive: true, force: true });
			rmSync(workerTmp(this.runId, target!.nodeId), { recursive: true, force: true });
			rmSync(tokenFile(this.runId, target!.nodeId), { force: true });
			return updateNode(this.runId, target!.nodeId, (node) => { node.cleanedAt = Date.now(); node.estimatedCost = estimatedCost; });
		}
		throw new Error(`Unknown swarm operation: ${kind}`);
	}

	poll(defaults?: LiveDefaults) {
		return this.serial(async () => {
			this.syncDefaults(defaults);
			this.owner.heartbeat();
			for (const listed of this.nodes()) {
				if (listed.role === "coordinator" || listed.cleanedAt) continue;
				for (const path of queuedRequests(this.runId, listed.nodeId)) {
					const requestId = basename(path, ".json");
					try {
						const request = readRequest(path, this.run.config.maxInlineBytes);
						if (request.requestId !== requestId) throw new Error("Request id does not match its filename");
						const actor = readNode(this.runId, listed.nodeId);
						const target = typeof request.payload.nodeId === "string" ? readNode(this.runId, request.payload.nodeId) : undefined;
						await applyRequest(request, actor, readFileSync(tokenFile(this.runId, actor.nodeId), "utf8"), () => this.perform(actor, request.kind, unpackPayload(this.runId, actor.nodeId, requestId, request.payload), target), target);
					} catch (error) {
						writeResponse(this.runId, listed.nodeId, { schemaVersion: SCHEMA_VERSION, requestId, ok: false, error: String(error), createdAt: Date.now() });
					} finally { rmSync(path, { force: true }); }
				}
				const node = readNode(this.runId, listed.nodeId);
				const process = this.processes.status(node);
				if (process?.pid && node.pid !== process.pid) updateNode(this.runId, node.nodeId, (current) => { current.pid = process.pid; });
				if (["starting", "running", "rework"].includes(node.status)) {
					const startupExpired = node.status === "starting" && this.run.status === "active" && Date.now() - node.updatedAt > this.run.config.startupTimeoutMs;
					if (startupExpired || process?.status === "exited" || process?.status === "failed" || process?.status === "timed-out") {
						await this.processes.set(node, "stopped");
						updateNode(this.runId, node.nodeId, (current) => { current.status = "failed"; current.failure = startupExpired ? "Worker readiness timed out" : process?.failure ?? `Worker ${process?.status}`; });
					}
				}
			}
			this.snapshot();
		});
	}

	setPaused(paused: boolean) {
		return this.serial(async () => {
			updateRun(this.runId, (run) => { run.status = paused ? "paused" : "active"; });
			for (const node of this.nodes()) {
				if (node.role === "coordinator" || terminalStatuses.has(node.status)) continue;
				await this.processes.set(node, paused ? "paused" : "running");
				updateNode(this.runId, node.nodeId, (current) => {
					if (paused) current.pausedAt ??= Date.now();
					else if (current.pausedAt) { if (current.deadlineAt) current.deadlineAt += Date.now() - current.pausedAt; current.pausedAt = null; }
				});
			}
			this.snapshot();
		});
	}

	bindSession(sessionId: string) {
		return this.serial(async () => {
			const existing = readJson<{ runId: string }>(sessionFile(sessionId));
			if (existing && existing.runId !== this.runId) throw new Error("Session is attached to another swarm");
			const previousSession = this.run.rootSessionId;
			writeJson(sessionFile(sessionId), { runId: this.runId });
			updateRun(this.runId, (run) => { run.rootSessionId = sessionId; });
			updateNode(this.runId, this.root.nodeId, (root) => { root.sessionId = sessionId; });
			if (previousSession !== sessionId) rmSync(sessionFile(previousSession), { force: true });
		});
	}

	kill() {
		return this.serial(async () => {
			for (const node of this.nodes().reverse()) {
				if (node.role === "coordinator" || node.cleanedAt) continue;
				await this.processes.set(node, "stopped");
				if (!terminalStatuses.has(node.status)) updateNode(this.runId, node.nodeId, (current) => { current.status = "stopped"; });
			}
			updateRun(this.runId, (run) => { run.status = "stopped"; });
			this.snapshot();
		});
	}

	clear() {
		return this.serial(async () => {
			const nodes = this.nodes().filter((node) => node.role !== "coordinator" && !node.cleanedAt);
			if (nodes.some((node) => !terminalStatuses.has(node.status))) throw new Error("Active swarm children must be killed before clearing. Run /swarm:kill first.");
			for (const node of nodes) assertCleanWorktree(node);
			for (const node of nodes) await this.processes.set(node, "stopped");
			const estimatedCosts = new Map(nodes.map((node) => [node.nodeId, workerCost(node)]));
			// Recheck after stopping; workers may have edited during the first pass.
			for (const node of nodes) assertCleanWorktree(node);
			for (const node of nodes) {
				git(this.run.gitRoot, ["worktree", "remove", node.cwd]);
				if (node.tmuxSession && node.tmuxWindow) killWindow(node.tmuxSession, node.tmuxWindow);
				updateNode(this.runId, node.nodeId, (current) => {
					if (!terminalStatuses.has(current.status)) current.status = "stopped";
					current.cleanedAt = Date.now();
					current.estimatedCost = estimatedCosts.get(node.nodeId);
				});
			}
			updateRun(this.runId, (run) => { run.status = "stopped"; run.clearedAt = Date.now(); });
			rmSync(sessionFile(this.run.rootSessionId), { force: true });
			for (const name of readdirSync(runDir(this.runId))) {
				if (name !== "control") rmSync(join(runDir(this.runId), name), { recursive: true, force: true });
			}
			for (const name of readdirSync(join(runDir(this.runId), "control"))) {
				// Retain node records: their cost snapshots are the only durable usage
				// source after worker homes and Pi session logs have been removed.
				if (!["run.json", "owner.lock", "nodes"].includes(name)) rmSync(join(runDir(this.runId), "control", name), { recursive: true, force: true });
			}
			this.changed();
		});
	}

	async close() {
		await this.queue;
		if (this.closed) return;
		this.closed = true;
		await this.owner.release();
		this.changed();
	}
}
