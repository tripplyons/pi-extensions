import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { SWARM_TOOL_NAMES } from "./index.ts";
import { isSwarmAttached } from "./events.ts";
import { makeNode, SwarmRuntime } from "./runtime.ts";
import { inboxDir, sessionFile, workerHome, writeJson } from "./state.ts";
import { WorkerMailbox } from "./worker.ts";
import { ManualScheduler } from "../test-scheduler.ts";

function harness(entries: any[] = [], initialActiveTools = ["read", "bash", "edit", "write"]) {
	const bus = new EventEmitter();
	const tools = new Map<string, any>();
	const activeTools = new Set(initialActiveTools);
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const messages: any[] = [];
	const pi = {
		events: { emit: (name: string, value: unknown) => bus.emit(name, value), on(name: string, listener: (...args: any[]) => void) { bus.on(name, listener); return () => bus.off(name, listener); } },
		registerTool(tool: any) { tools.set(tool.name, tool); activeTools.add(tool.name); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		getActiveTools: () => [...activeTools],
		getAllTools: () => [...tools.values()],
		setActiveTools(names: string[]) { activeTools.clear(); for (const name of names) activeTools.add(name); },
		getThinkingLevel: () => "low",
		on(name: string, handler: Function) { handlers.set(name, handler); },
		sendMessage(message: any) { messages.push(message); entries.push({ type: "message", message: { role: "custom", ...message } }); },
	};
	return { pi, bus, handlers, tools, commands, messages, activeTools };
}

const activeSwarmTools = (active: ReturnType<typeof harness>) => active.pi.getActiveTools().filter(name => name.startsWith("swarm_"));

test("swarm tools stay inactive in a fresh session while unrelated tools survive", async () => {
	const unrelated = ["read", "bash", "edit", "write", "unrelated_tool"];
	const active = harness([], unrelated);
	const ctx = { sessionManager: { getSessionId: () => "fresh", getBranch: () => [] }, ui: { setStatus() {} } };
	try {
		await extension(active.pi as any);
		await active.handlers.get("session_start")!({}, ctx);
		expect(activeSwarmTools(active)).toEqual([]);
		expect(active.pi.getActiveTools()).toEqual(unrelated);
		expect(active.pi.getAllTools().map(tool => tool.name).filter(name => name.startsWith("swarm_"))).toEqual([...SWARM_TOOL_NAMES]);
	} finally { await active.handlers.get("session_shutdown")?.({}, ctx); }
});

test("swarm start snapshots both enabled and disabled coordinator fast mode", async () => {
	for (const enabled of [true, false]) {
		const active = harness();
		active.bus.on("fast:query", (query: { enabled?: boolean }) => { query.enabled = enabled; });
		const created: any[] = [];
		const create = spyOn(SwarmRuntime, "create").mockImplementation(async (input: any) => {
			created.push(input);
			return { runId: "run_fast", run: { status: "active", config: input.config }, view: () => ({ status: "active", node: makeNode("run_fast", "node_root", "coordinator", "x", "/tmp", null), nodes: [], messages: [] }), async poll() {}, async close() {} } as any;
		});
		const ctx = { cwd: "/tmp", model: { provider: "openai-codex", id: "gpt" }, sessionManager: { getSessionId: () => "fast", getBranch: () => [] }, ui: { notify() {}, setStatus() {} } };
		try {
			await extension(active.pi as any);
			await active.handlers.get("session_start")!({}, ctx);
			expect(activeSwarmTools(active)).toEqual([]);
			await active.commands.get("swarm:start").handler("objective", ctx);
			expect(created[0].config.fastMode).toBe(enabled);
			expect(activeSwarmTools(active)).toEqual([...SWARM_TOOL_NAMES]);
		} finally {
			await active.handlers.get("session_shutdown")?.({}, ctx);
			create.mockRestore();
		}
	}
});

test("session replacement disables swarm tools while live restore re-enables them", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-availability-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = directory;
	const root = makeNode("run_restore", "node_root", "coordinator", "Restore", directory, null);
	const activeRuntime = { runId: root.runId, root, run: { status: "active", config: { pollIntervalMs: 50, maxInlineBytes: 65536 } }, view: () => ({ status: "active", node: root, nodes: [], messages: [] }), async poll() {}, async close() {} };
	const stoppedRuntime = { ...activeRuntime, run: { ...activeRuntime.run, status: "stopped" } };
	const resume = spyOn(SwarmRuntime, "resume").mockImplementation(async (runId: string) => (runId === "run_stopped" ? stoppedRuntime : activeRuntime) as any);
	const unrelated = ["read", "bash", "edit", "write", "unrelated_tool"];
	const old = harness([], unrelated);
	const replacement = harness([], unrelated);
	const stopped = harness([], unrelated);
	const oldCtx = { sessionManager: { getSessionId: () => "restored", getBranch: () => [] }, ui: { setStatus() {} } };
	const replacementCtx = { sessionManager: { getSessionId: () => "fresh_replacement", getBranch: () => [] }, ui: { setStatus() {} } };
	const stoppedCtx = { sessionManager: { getSessionId: () => "stopped", getBranch: () => [] }, ui: { setStatus() {} } };
	try {
		writeJson(sessionFile("restored"), { runId: root.runId });
		await extension(old.pi as any);
		await old.handlers.get("session_start")!({}, oldCtx);
		expect(activeSwarmTools(old)).toEqual([...SWARM_TOOL_NAMES]);
		await old.handlers.get("session_shutdown")!({}, oldCtx);
		expect(activeSwarmTools(old)).toEqual([]);

		await extension(replacement.pi as any);
		await replacement.handlers.get("session_start")!({}, replacementCtx);
		expect(activeSwarmTools(replacement)).toEqual([]);
		expect(replacement.pi.getActiveTools()).toEqual(unrelated);

		writeJson(sessionFile("stopped"), { runId: "run_stopped" });
		await extension(stopped.pi as any);
		await stopped.handlers.get("session_start")!({}, stoppedCtx);
		expect(activeSwarmTools(stopped)).toEqual([]);
	} finally {
		await old.handlers.get("session_shutdown")?.({}, oldCtx);
		await replacement.handlers.get("session_shutdown")?.({}, replacementCtx);
		await stopped.handlers.get("session_shutdown")?.({}, stoppedCtx);
		resume.mockRestore();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("worker tools activate only after a successful ready handshake", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-worker-availability-"));
	const previousHome = process.env.PI_SWARM_HOME;
	const keys = ["PI_SWARM_WORKER", "PI_SWARM_RUN", "PI_SWARM_NODE", "PI_SWARM_TOKEN"];
	const previous = keys.map(key => process.env[key]);
	process.env.PI_SWARM_HOME = directory;
	Object.assign(process.env, { PI_SWARM_WORKER: "1", PI_SWARM_RUN: "run_worker", PI_SWARM_NODE: "node_worker", PI_SWARM_TOKEN: "token" });
	const success = harness();
	const failed = harness();
	const successCtx = { sessionManager: { getSessionId: () => "worker_success", getBranch: () => [] }, ui: { setStatus() {} } };
	const failedCtx = { sessionManager: { getSessionId: () => "worker_failed", getBranch: () => [] }, ui: { setStatus() {} } };
	const request = spyOn(WorkerMailbox.prototype, "request").mockResolvedValue({});
	try {
		await extension(success.pi as any);
		await success.handlers.get("session_start")!({}, successCtx);
		expect(request).toHaveBeenCalledWith("ready", { sessionId: "worker_success" });
		expect(activeSwarmTools(success)).toEqual([...SWARM_TOOL_NAMES]);
		await success.handlers.get("session_shutdown")!({}, successCtx);
		expect(activeSwarmTools(success)).toEqual([]);

		request.mockRejectedValueOnce(new Error("controller unavailable"));
		await extension(failed.pi as any);
		await expect(failed.handlers.get("session_start")!({}, failedCtx)).rejects.toThrow("controller unavailable");
		expect(activeSwarmTools(failed)).toEqual([]);
		expect(isSwarmAttached(failed.pi as any)).toBe(false);
	} finally {
		await success.handlers.get("session_shutdown")?.({}, successCtx);
		await failed.handlers.get("session_shutdown")?.({}, failedCtx);
		request.mockRestore();
		for (const [index, key] of keys.entries()) {
			if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
		}
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("swarm status command reports coordinator and durable worker costs", async () => {
	const root = makeNode("run_status", "node_root", "coordinator", "root", "/tmp", null);
	const child = makeNode(root.runId, "node_child", "worker", "work", "/tmp", root.nodeId);
	child.status = "completed";
	const live = makeNode(root.runId, "node_live", "worker", "live work", "/tmp", root.nodeId);
	live.status = "running";
	const cleaned = makeNode(root.runId, "node_cleaned", "worker", "old work", "/tmp", root.nodeId);
	cleaned.status = "completed";
	cleaned.cleanedAt = Date.now();
	cleaned.estimatedCost = 2.25;
	const runtime = { runId: root.runId, root, run: { status: "active", createdAt: Date.now() - 1000, config: { pollIntervalMs: 50, maxInlineBytes: 65536 } }, view: () => ({ status: "active", node: root, nodes: [root, child, live, cleaned], messages: [{ messageId: "m" }] }), async poll() {}, async close() {} };
	const resume = spyOn(SwarmRuntime, "resume").mockResolvedValue(runtime as any);
	const active = harness();
	let notice = "";
	const ctx = { model: { provider: "openai-codex", id: "gpt" }, sessionManager: { getSessionId: () => "status", getBranch: () => [], getEntries: () => [{ type: "message", message: { role: "assistant", usage: { cost: { total: 1.5 } } } }] }, ui: { notify(value: string) { notice = value; }, setStatus() {} }, isIdle: () => false, hasPendingMessages: () => false };
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-status-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = directory;
	try {
		const sessions = join(workerHome(root.runId, child.nodeId), ".pi", "agent", "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "completed.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } })}\n`);
		writeFileSync(join(sessions, "restarted.jsonl"), `${JSON.stringify({ type: "compaction", usage: { cost: { total: 2 } } })}\n`);
		const liveSessions = join(workerHome(root.runId, live.nodeId), ".pi", "agent", "sessions");
		mkdirSync(liveSessions, { recursive: true });
		writeFileSync(join(liveSessions, "live.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.5 } } } })}\n`);
		writeJson(sessionFile("status"), { runId: root.runId });
		await extension(active.pi as any);
		await active.handlers.get("session_start")!({}, ctx);
		await active.commands.get("swarm:status").handler("", ctx);
		expect(notice).toContain("Nodes: 3 · running 1 · completed 2");
		expect(notice).toContain("Coordinator inbox: 1");
		expect(notice).toContain("Estimated cost: $7.250");
	} finally {
		await active.handlers.get("session_shutdown")?.({}, ctx);
		resume.mockRestore();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("swarm system prompt is frozen across turns and child lifecycle changes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-prompt-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = directory;
	const root = makeNode("run_prompt", "node_root", "coordinator", "Objective", directory, null);
	const child = makeNode(root.runId, "node_child", "worker", "Work", directory, root.nodeId);
	const view = { status: "active", node: root, nodes: [root, child], messages: [] };
	const runtime = { runId: root.runId, root, run: { status: "active", config: { pollIntervalMs: 50, maxInlineBytes: 65536 } }, view: () => view, async poll() {}, async close() {}, async kill() { this.run.status = "stopped"; } };
	const resume = spyOn(SwarmRuntime, "resume").mockResolvedValue(runtime as any);
	const active = harness();
	const ctx = { model: { provider: "openai-codex", id: "gpt" }, sessionManager: { getSessionId: () => "prompt", getBranch: () => [] }, ui: { notify() {}, setStatus() {} }, isIdle: () => false, hasPendingMessages: () => false };
	try {
		writeJson(sessionFile("prompt"), { runId: root.runId });
		await extension(active.pi as any);
		await active.handlers.get("session_start")!({}, ctx);
		const first = await active.handlers.get("before_agent_start")!({ systemPrompt: "base before swarm state changes" }, ctx);
		expect(first.systemPrompt).toContain("root coordinator may stage and commit only changes the user explicitly authorizes in its own checkout");
		expect(first.systemPrompt).toContain("preserve unrelated changes");
		expect(first.systemPrompt).toContain("submit changes with swarm_complete");
		expect(first.systemPrompt).toContain("managers integrate accepted children with swarm_integrate");
		expect(first.systemPrompt).toContain("Child integration, child worktrees, lifecycle, and shared Git metadata remain controller-owned");
		expect(first.systemPrompt).toContain("Never push, reset, clean, rebase, or perform other destructive Git operations");
		expect(first.systemPrompt).not.toContain("The controller alone owns Git locks and commits");
		expect(first.systemPrompt).toContain("Keep other nodes' worktrees unchanged during verification, including generated caches");
		expect(first.systemPrompt).toContain("python -B or PYTHONDONTWRITEBYTECODE=1");
		expect(first.systemPrompt).toContain("Never delete unknown changes to make cleanup pass");
		expect(first.systemPrompt).toContain("Authorized coordinators and managers may create managed children with swarm_spawn");
		expect(first.systemPrompt).toContain("Workers and reviewers cannot spawn children");
		expect(first.systemPrompt).toContain("If Mixture is loaded, its lead may use active known swarm tools");
		expect(first.systemPrompt).toContain("The Mixture writer cannot call swarm tools");
		expect(first.systemPrompt).not.toContain("Mixture model while attached");
		expect(first.systemPrompt).not.toContain("Never create subagents");
		expect(first.systemPrompt).not.toContain("Never run Git mutations such as git add, commit, merge, cherry-pick, or rebase");
		expect(first.systemPrompt).toContain("delivered through managed messages and wake-ups");
		expect(first.systemPrompt).toContain("end the turn");
		expect(first.systemPrompt).toContain("never poll swarm state or run sleep loops");
		expect(active.tools.get("swarm_task").description).toContain("do not poll or sleep solely for state changes");
		child.status = "running";
		view.messages.push({ messageId: "message_1" });
		const second = await active.handlers.get("before_agent_start")!({ systemPrompt: "rebuilt base after another turn" }, ctx);
		child.status = "awaiting-review";
		const third = await active.handlers.get("before_agent_start")!({ systemPrompt: "another rebuilt base" }, ctx);
		expect(second.systemPrompt).toBe(first.systemPrompt);
		expect(third.systemPrompt).toBe(first.systemPrompt);
		await active.commands.get("swarm:kill").handler("", ctx);
		expect(activeSwarmTools(active)).toEqual([]);
		expect(await active.handlers.get("before_agent_start")!({ systemPrompt: "after stop" }, ctx)).toBeUndefined();
	} finally {
		await active.handlers.get("session_shutdown")?.({}, ctx);
		resume.mockRestore();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("before_agent_start keeps child Git guidance controller-owned", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-role-prompt-"));
	const previousHome = process.env.PI_SWARM_HOME;
	const environmentKeys = ["PI_SWARM_WORKER", "PI_SWARM_RUN", "PI_SWARM_NODE", "PI_SWARM_TOKEN"];
	const previousEnvironment = environmentKeys.map((key) => process.env[key]);
	const request = spyOn(WorkerMailbox.prototype, "request").mockResolvedValue({});
	process.env.PI_SWARM_HOME = directory;
	try {
		for (const role of ["worker", "manager", "reviewer"] as const) {
			const runId = `run_prompt${role}`;
			const nodeId = `node_prompt${role}`;
			Object.assign(process.env, { PI_SWARM_WORKER: "1", PI_SWARM_RUN: runId, PI_SWARM_NODE: nodeId, PI_SWARM_TOKEN: "token" });
			writeJson(join(inboxDir(runId, nodeId), "snapshot.json"), {
				schemaVersion: 2, status: "active", maxInlineBytes: 65536,
				node: makeNode(runId, nodeId, role, "Task", "/tmp", "node_parent"), nodes: [], messages: [],
			});
			const active = harness();
			const ctx = { sessionManager: { getSessionId: () => `role-${role}`, getBranch: () => [] }, ui: { setStatus() {} } };
			try {
				await extension(active.pi as any);
				await active.handlers.get("session_start")!({}, ctx);
				const prompt = await active.handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx);
				expect(prompt.systemPrompt).toContain(`Swarm role: ${role}.`);
				expect(prompt.systemPrompt).toContain("Never run Git mutations such as git add, commit, merge, cherry-pick, or rebase");
				expect(prompt.systemPrompt).toContain("workers and managers submit changes with swarm_complete");
				expect(prompt.systemPrompt).toContain("managers integrate accepted children with swarm_integrate");
				expect(prompt.systemPrompt).toContain("The controller alone owns Git locks and commits");
				expect(prompt.systemPrompt).not.toContain("root coordinator may stage and commit");
				expect(prompt.systemPrompt).not.toContain("Do not claim that all commits belong to the controller");
				if (role === "manager") expect(prompt.systemPrompt).toContain("Authorized coordinators and managers may create managed children with swarm_spawn");
				if (role === "worker" || role === "reviewer") expect(prompt.systemPrompt).toContain("Workers and reviewers cannot spawn children");
			} finally { await active.handlers.get("session_shutdown")?.({}, ctx); }
		}
	} finally {
		request.mockRestore();
		for (const [index, key] of environmentKeys.entries()) {
			if (previousEnvironment[index] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[index];
		}
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("kill and clear deactivate swarm tools", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-stop-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = directory;
	const root = makeNode("run_stop", "node_root", "coordinator", "Stop", directory, null);
	const runtime: any = { runId: root.runId, root, run: { status: "active", config: { pollIntervalMs: 50, maxInlineBytes: 65536 } }, view: () => ({ status: runtime.run.status, node: root, nodes: [], messages: [] }), async poll() {}, async close() {}, async kill() { runtime.run.status = "stopped"; }, async clear() { runtime.run.status = "stopped"; } };
	const resume = spyOn(SwarmRuntime, "resume").mockResolvedValue(runtime);
	const active = harness();
	const ctx = { sessionManager: { getSessionId: () => "stop", getBranch: () => [] }, ui: { notify() {}, setStatus() {} } };
	try {
		writeJson(sessionFile("stop"), { runId: root.runId });
		await extension(active.pi as any);
		await active.handlers.get("session_start")!({}, ctx);
		expect(activeSwarmTools(active)).toEqual([...SWARM_TOOL_NAMES]);
		await active.commands.get("swarm:kill").handler("", ctx);
		expect(activeSwarmTools(active)).toEqual([]);
		await active.commands.get("swarm:clear").handler("", ctx);
		expect(activeSwarmTools(active)).toEqual([]);
	} finally {
		await active.handlers.get("session_shutdown")?.({}, ctx);
		resume.mockRestore();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("swarm_task returns a full view followed by versioned deltas and can refresh its baseline", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-task-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = directory;
	const root = makeNode("run_task", "node_root", "coordinator", "Objective", directory, null);
	const child = makeNode(root.runId, "node_child", "worker", "Work", directory, root.nodeId);
	const view: any = { status: "active", node: root, nodes: [root, child], messages: [] };
	const runtime = {
		runId: root.runId, root, run: { status: "active", config: { pollIntervalMs: 1000, maxInlineBytes: 65536 } },
		view: () => view, async poll() {}, async close() {},
		async act(_nodeId: string, kind: string, payload: any) {
			if (kind === "heartbeat" && payload.ackIds) view.messages = view.messages.filter((message: any) => !payload.ackIds.includes(message.messageId));
		},
	};
	const resume = spyOn(SwarmRuntime, "resume").mockResolvedValue(runtime as any);
	const active = harness();
	const ctx = { model: { provider: "openai-codex", id: "gpt" }, sessionManager: { getSessionId: () => "task", getBranch: () => [] }, ui: { notify() {}, setStatus() {} }, isIdle: () => false, hasPendingMessages: () => false };
	const invoke = async (params: any = {}) => JSON.parse((await active.tools.get("swarm_task").execute("id", params)).content[0].text);
	try {
		writeJson(sessionFile("task"), { runId: root.runId });
		await extension(active.pi as any);
		await active.handlers.get("session_start")!({}, ctx);
		expect(await invoke()).toEqual(view);
		expect(await invoke()).toEqual({ schemaVersion: 2, runId: root.runId, full: false, changed: false });

		root.version++;
		const selfChanged = await invoke();
		expect(selfChanged.node).toEqual(root);
		expect(selfChanged.nodes).toBeUndefined();

		child.version++;
		view.messages.push({ messageId: "message_new", runId: root.runId, toNodeId: root.nodeId, body: "report" });
		const changed = await invoke();
		expect(changed.changed).toBe(true);
		expect(changed.nodes).toEqual([child]);
		expect(changed.messages).toEqual(view.messages);

		const acknowledged = await invoke({ acknowledge: ["message_new"] });
		expect(acknowledged.acknowledgedMessageIds).toEqual(["message_new"]);
		view.status = "stopped";
		expect((await invoke()).status).toBe("stopped");
		expect(await invoke({ full: true })).toEqual(view);
		expect(await invoke()).toEqual({ schemaVersion: 2, runId: root.runId, full: false, changed: false });

		await active.handlers.get("session_shutdown")!({}, ctx);
		expect(active.pi.getActiveTools().filter(name => name.startsWith("swarm_"))).toEqual([]);
		await active.handlers.get("session_start")!({}, ctx);
		expect(active.pi.getActiveTools().filter(name => name.startsWith("swarm_"))).toEqual([...SWARM_TOOL_NAMES]);
		expect(await invoke()).toEqual(view);
	} finally {
		await active.handlers.get("session_shutdown")?.({}, ctx);
		resume.mockRestore();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("every registered native swarm operation rejects calls without an attachment", async () => {
	const { pi, handlers, tools } = harness();
	await extension(pi as any);
	for (const tool of tools.values()) {
		const parameters = tools.get(tool.name).parameters;
		const input = Object.fromEntries((parameters.required ?? []).map((key: string) => [key, key === "action" ? "accept" : "test"]));
		await expect(tool.execute("unattached", input, new AbortController().signal, undefined, {})).rejects.toThrow("No swarm attached");
	}
	await handlers.get("session_shutdown")!({}, { ui: { setStatus() {} } });
});

test("monitor waits for idle, deduplicates wakes, and restores its generation after history compaction and reload", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-monitor-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = directory;
	const root = makeNode("run_monitor", "node_root", "coordinator", "Durable objective", directory, null);
	const child = makeNode(root.runId, "node_child", "worker", "Work", directory, root.nodeId);
	child.status = "awaiting-review";
	const view = { status: "active", node: root, nodes: [root, child], messages: [] };
	const runtime = { runId: root.runId, root, run: { status: "active", config: { pollIntervalMs: 50 } }, view: () => view, async poll() {}, async close() {} };
	const resume = spyOn(SwarmRuntime, "resume").mockResolvedValue(runtime as any);
	const entries: any[] = [];
	let idle = false;
	let pending = false;
	const ctx = { model: { provider: "openai-codex", id: "gpt" }, sessionManager: { getSessionId: () => "monitor", getBranch: () => entries }, ui: { notify() {}, setStatus() {} }, isIdle: () => idle, hasPendingMessages: () => pending };
	let active = harness(entries);
	let scheduler = new ManualScheduler();
	const activity: unknown[] = [];
	active.bus.on("tripp:agent-swarm-activity", (event) => activity.push(event));
	try {
		writeJson(sessionFile("monitor"), { runId: root.runId });
		await extension(active.pi as any, { scheduler });
		await active.handlers.get("session_start")!({}, ctx);
		await scheduler.advanceBy(350);
		expect(active.messages).toHaveLength(0);
		expect(activity).toHaveLength(1);
		idle = true; pending = true;
		await scheduler.advanceBy(150);
		expect(active.messages).toHaveLength(0);
		expect(activity).toHaveLength(1);
		pending = false;
		await scheduler.advanceBy(150);
		expect(active.messages).toHaveLength(1);
		await scheduler.advanceBy(150);
		expect(active.messages).toHaveLength(1);
		await active.handlers.get("session_shutdown")!({}, ctx);
		active = harness(entries);
		scheduler = new ManualScheduler();
		await extension(active.pi as any, { scheduler });
		await active.handlers.get("session_start")!({}, ctx);
		await scheduler.advanceBy(350);
		expect(active.messages).toHaveLength(0);
		const prompt = await active.handlers.get("before_agent_start")!({ systemPrompt: "Compacted context" }, ctx);
		expect(prompt.systemPrompt).toContain("Read swarm_task");
		child.status = "failed";
		await scheduler.advanceBy(150);
		expect(active.messages).toHaveLength(1);
	} finally {
		await active.handlers.get("session_shutdown")?.({}, ctx);
		resume.mockRestore();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("failed automatic reconnect restores detached sibling-tool state", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-reconnect-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = directory;
	const resume = spyOn(SwarmRuntime, "resume").mockRejectedValue(new Error("ownership unavailable"));
	const active = harness();
	const ctx = { sessionManager: { getSessionId: () => "reconnect", getBranch: () => [] }, ui: { notify() {}, setStatus() {} } };
	try {
		writeJson(sessionFile("reconnect"), { runId: "run_saved" });
		await extension(active.pi as any);
		await expect(active.handlers.get("session_start")!({}, ctx)).rejects.toThrow("ownership unavailable");
		expect(activeSwarmTools(active)).toEqual([]);
		expect(active.pi.getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
		expect(isSwarmAttached(active.pi as any)).toBe(false);
	} finally {
		await active.handlers.get("session_shutdown")?.({}, ctx);
		resume.mockRestore();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
