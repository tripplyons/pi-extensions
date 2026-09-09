import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCodeModeExtensionToolSnapshot } from "@howaboua/pi-codex-conversion/dist/code-mode-extension-tools.js";
import extension from "./index.ts";
import { isSwarmAttached } from "./events.ts";
import { makeNode, SwarmRuntime } from "./runtime.ts";
import { sessionFile, writeJson } from "./state.ts";

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
	const ctx = { sessionManager: { getSessionId: () => "prompt", getBranch: () => [] }, ui: { notify() {}, setStatus() {} }, isIdle: () => false, hasPendingMessages: () => false };
	try {
		writeJson(sessionFile("prompt"), { runId: root.runId });
		await extension(active.pi as any);
		await active.handlers.get("session_start")!({}, ctx);
		const first = await active.handlers.get("before_agent_start")!({ systemPrompt: "base before swarm state changes" }, ctx);
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
	const ctx = { sessionManager: { getSessionId: () => "task", getBranch: () => [] }, ui: { notify() {}, setStatus() {} }, isIdle: () => false, hasPendingMessages: () => false };
	const invoke = async (params: any = {}) => JSON.parse((await active.tools.get("swarm_task").execute("id", params)).content[0].text);
	try {
		writeJson(sessionFile("task"), { runId: root.runId });
		await extension(active.pi as any);
		await active.handlers.get("session_start")!({}, ctx);
		expect(await invoke()).toEqual(view);
		expect(await invoke()).toEqual({ schemaVersion: 2, runId: root.runId, full: false, changed: false });

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
	} finally {
		await active.handlers.get("session_shutdown")?.({}, ctx);
		resume.mockRestore();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("every registered swarm operation is callable through Code mode and unregisters on shutdown", async () => {
	const { pi, handlers, tools } = harness();
	await extension(pi as any);
	const snapshot = () => getCodeModeExtensionToolSnapshot(pi as any, {} as any, true);
	expect(snapshot().tools.map((tool) => tool.name).sort()).toEqual([...tools.keys()].sort());
	for (const tool of snapshot().tools) {
		const parameters = tools.get(tool.name).parameters;
		const input = Object.fromEntries((parameters.required ?? []).map((key: string) => [key, key === "action" ? "accept" : "test"]));
		await expect(tool.invoke(input, { extensionContext: {} } as any, new AbortController().signal)).rejects.toThrow("No swarm attached");
	}
	await handlers.get("session_shutdown")!({}, { ui: { setStatus() {} } });
	expect(snapshot().tools).toEqual([]);
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
	const ctx = { sessionManager: { getSessionId: () => "monitor", getBranch: () => entries }, ui: { notify() {}, setStatus() {} }, isIdle: () => idle, hasPendingMessages: () => pending };
	let active = harness(entries);
	try {
		writeJson(sessionFile("monitor"), { runId: root.runId });
		await extension(active.pi as any);
		await active.handlers.get("session_start")!({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(active.messages).toHaveLength(0);
		idle = true; pending = true;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(active.messages).toHaveLength(0);
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
