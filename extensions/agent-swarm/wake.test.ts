import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import swarm from "./index.ts";
import { makeNode, SwarmRuntime } from "./runtime.ts";
import { sessionFile, writeJson } from "./state.ts";
import { WorkerMailbox } from "./worker.ts";

for (const worker of [false, true]) test(`${worker ? "worker mailbox" : "coordinator completion"} wakes bg-bash while the agent is busy`, async () => {
	const root = mkdtempSync(join(tmpdir(), "swarm-sleep-"));
	const previousHome = process.env.PI_SWARM_HOME;
	const previousCache = process.env.XDG_CACHE_HOME;
	const keys = ["PI_SWARM_WORKER", "PI_SWARM_RUN", "PI_SWARM_NODE", "PI_SWARM_TOKEN"];
	const previous = keys.map((key) => process.env[key]);
	if (worker) Object.assign(process.env, { PI_SWARM_WORKER: "1", PI_SWARM_RUN: "run_wake", PI_SWARM_NODE: "node_child", PI_SWARM_TOKEN: "test" });
	process.env.PI_SWARM_HOME = root;
	process.env.XDG_CACHE_HOME = root;
	const { default: bg } = await import("../bg-bash/index.ts");
	const bus = new EventEmitter();
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const pi: any = {
		events: { on(n: string, f: any) { bus.on(n, f); return () => bus.off(n, f); }, emit(n: string, v: any) { bus.emit(n, v); } },
		on(n: string, f: Function) { handlers.set(n, [...(handlers.get(n) ?? []), f]); },
		registerTool(t: any) { tools.set(t.name, t); }, registerCommand() {},
		getThinkingLevel: () => "low",
		sendMessage() { throw new Error("Busy coordinator must not deliver idle messages"); },
	};
	const node = makeNode("run_wake", "node_root", "coordinator", "test", root, null);
	const child = makeNode(node.runId, "node_child", "worker", "test", root, node.nodeId);
	child.status = "running";
	const runtime = { runId: node.runId, root: node, run: { status: "active", config: { pollIntervalMs: 50 } }, view: () => ({ status: "active", node, nodes: [node, child], messages: [] }), async poll() {}, async close() {} };
	const resume = spyOn(SwarmRuntime, "resume").mockResolvedValue(runtime as any);
	const messages: any[] = [];
	const snapshot = worker ? spyOn(WorkerMailbox.prototype, "snapshot").mockImplementation(() => ({ status: "active", node: child, nodes: [child], messages }) as any) : undefined;
	const request = worker ? spyOn(WorkerMailbox.prototype, "request").mockResolvedValue({}) : undefined;
	const ctx: any = { model: { provider: "openai-codex", id: "test" }, sessionManager: { getSessionId: () => "wake", getBranch: () => [] }, ui: { notify() {}, setStatus() {} }, isIdle: () => false, hasPendingMessages: () => false };
	const abort = new AbortController();
	try {
		writeJson(sessionFile("wake"), { runId: node.runId });
		bg(pi); await swarm(pi);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		const sleeping = tools.get("sleep").execute("sleep", { seconds: 10 }, abort.signal);
		child.status = "awaiting-review";
		if (worker) { child.status = "running"; messages.push({ messageId: "message_ready" }); }
		const result = await sleeping;
		expect(result.details.wokeEarly).toBe(true);
		expect(result.details.agentSwarm.runId).toBe(node.runId);
		expect(result.details.sleptSeconds).toBeLessThan(2);
	} finally {
		abort.abort();
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		resume.mockRestore();
		snapshot?.mockRestore(); request?.mockRestore();
		for (const [index, key] of keys.entries()) {
			if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
		}
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
		rmSync(root, { recursive: true, force: true });
	}
	expect(bus.listenerCount("tripp:agent-swarm-activity")).toBe(0);
});
