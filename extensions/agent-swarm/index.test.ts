import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
import { isSwarmAttached } from "./events.ts";
import { makeNode, SwarmRuntime } from "./runtime.ts";
import { sessionFile, workerHome, writeJson } from "./state.ts";

function harness(entries: any[] = []) {
	const bus = new EventEmitter();
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const messages: any[] = [];
	const pi = {
		events: { emit: (name: string, value: unknown) => bus.emit(name, value), on(name: string, listener: (...args: any[]) => void) { bus.on(name, listener); return () => bus.off(name, listener); } },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		getAllTools: () => [...tools.values()],
		getThinkingLevel: () => "low",
		on(name: string, handler: Function) { handlers.set(name, handler); },
		sendMessage(message: any) { messages.push(message); entries.push({ type: "message", message: { role: "custom", ...message } }); },
	};
	return { pi, bus, handlers, tools, commands, messages };
}

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
			await active.commands.get("swarm:start").handler("objective", ctx);
			expect(created[0].config.fastMode).toBe(enabled);
		} finally {
			await active.handlers.get("session_shutdown")?.({}, ctx);
			create.mockRestore();
		}
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
		expect(first.systemPrompt).toContain("submit changes with swarm_complete");
		expect(first.systemPrompt).toContain("managers integrate accepted children with swarm_integrate");
		expect(first.systemPrompt).toContain("controller alone owns Git locks");
		expect(first.systemPrompt).toContain("Authorized coordinators and managers may create managed children with swarm_spawn");
		expect(first.systemPrompt).toContain("Workers and reviewers cannot spawn children");
		expect(first.systemPrompt).toContain("Never use unmanaged subagent or mixture tools while attached");
		expect(first.systemPrompt).not.toContain("Never create subagents");
		expect(first.systemPrompt).toContain("Never run Git mutations");
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
		expect(await active.handlers.get("before_agent_start")!({ systemPrompt: "after stop" }, ctx)).toBeUndefined();
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

		await active.handlers.get("session_switch")!({}, ctx);
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
	const activity: unknown[] = [];
	active.bus.on("tripp:agent-swarm-activity", (event) => activity.push(event));
	try {
		writeJson(sessionFile("monitor"), { runId: root.runId });
		await extension(active.pi as any);
		await active.handlers.get("session_start")!({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(active.messages).toHaveLength(0);
		expect(activity).toHaveLength(1);
		idle = true; pending = true;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(active.messages).toHaveLength(0);
		expect(activity).toHaveLength(1);
		pending = false;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(active.messages).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(active.messages).toHaveLength(1);
		await active.handlers.get("session_shutdown")!({}, ctx);
		active = harness(entries);
		await extension(active.pi as any);
		await active.handlers.get("session_start")!({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(active.messages).toHaveLength(0);
		const prompt = await active.handlers.get("before_agent_start")!({ systemPrompt: "Compacted context" }, ctx);
		expect(prompt.systemPrompt).toContain("Read swarm_task");
		child.status = "failed";
		await new Promise((resolve) => setTimeout(resolve, 150));
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
		expect(isSwarmAttached(active.pi as any)).toBe(false);
	} finally {
		await active.handlers.get("session_shutdown")?.({}, ctx);
		resume.mockRestore();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
