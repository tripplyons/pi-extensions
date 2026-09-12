import { describe, expect, jest, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishSwarmAttachment, SWARM_ATTACHMENT_CHANGED_EVENT, SWARM_ATTACHMENT_QUERY_EVENT } from "../agent-swarm/events.ts";

const { createSubagentExtension } = await import("./index.ts");

class FakeChild extends EventEmitter {
	pid = 987_654;
	stdout = new PassThrough();
	stderr = new PassThrough();
	killedWith: NodeJS.Signals[] = [];
	constructor(private readonly closeOnKill = true) { super(); }
	unref() {}
	kill(signal: NodeJS.Signals = "SIGTERM") {
		this.killedWith.push(signal);
		if (this.closeOnKill) queueMicrotask(() => this.emit("close", null));
		return true;
	}
}

const createHarness = ({ closeOnKill = true, initiallyAttached = false } = {}) => {
	const children: FakeChild[] = [];
	const invocations: Array<{ command: string; args: string[]; options: any }> = [];
	const tools = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const messages: Array<{ message: any; options: any }> = [];
	const emitted: Array<{ channel: string; event: any }> = [];
	const listeners = new Map<string, (value: any) => void>();
	let activeTools = ["read", "bash", "subagent", "subagent_process"];
	const spawnChild = (command: string, args: string[], options: any) => {
		const child = new FakeChild(closeOnKill);
		children.push(child);
		invocations.push({ command, args, options });
		return child as any;
	};
	const pi = {
		events: {
			emit(channel: string, event: any) { emitted.push({ channel, event }); listeners.get(channel)?.(event); },
			on(channel: string, handler: (value: any) => void) { listeners.set(channel, handler); return () => { listeners.delete(channel); }; },
		},
		getAllTools: () => [...tools.values()],
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		on(event: string, handler: (...args: any[]) => any) {
			const previous = handlers.get(event);
			handlers.set(event, async (...args) => { await previous?.(...args); return handler(...args); });
		},
		registerMessageRenderer() {},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		sendMessage(message: any, options: any) { messages.push({ message, options }); },
	};
	const attachment = initiallyAttached ? publishSwarmAttachment(pi as any, true) : undefined;
	createSubagentExtension(pi as any, spawnChild as any);
	const ctx = {
		cwd: "/tmp/project",
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => "session-test" },
	};
	return {
		children, emitted, handlers, invocations, messages, tools, ctx, pi, attachment,
		activeTools: () => activeTools,
		emitEvent: (channel: string, event: any) => pi.events.emit(channel, event),
	};
};

const assistantEvent = (text: string, extra: object = {}) => `${JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } },
		...extra,
	},
})}\n`;

describe("asynchronous subagent", () => {
	test("child completion wakes a pending bg-bash sleep", async () => {
		const previousCache = process.env.XDG_CACHE_HOME;
		const cache = mkdtempSync(join(tmpdir(), "subagent-wake-"));
		process.env.XDG_CACHE_HOME = cache;
		const { default: bg } = await import("../bg-bash/index.ts");
		const harness = createHarness();
		const abort = new AbortController();
		try {
			bg({ ...harness.pi, registerCommand() {} } as any);
			await harness.handlers.get("session_start")?.({}, harness.ctx);
			await harness.tools.get("subagent").execute("start", { task: "fixture" }, undefined, undefined, harness.ctx);
			const sleeping = harness.tools.get("sleep").execute("sleep", { seconds: 10 }, abort.signal);
			harness.children[0].stdout.write(assistantEvent("done"));
			harness.children[0].emit("close", 0);
			const result = await sleeping;
			expect(result.details.asyncJob.source).toBe("subagent");
			expect(result.details.asyncJob.status).toBe("exited");
			expect(result.details.sleptSeconds).toBeLessThan(2);
		} finally {
			abort.abort();
			await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
			if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
			rmSync(cache, { recursive: true, force: true });
		}
	});

	test("initial attachment hides creation and session start repairs stale direct visibility", async () => {
		const harness = createHarness({ initiallyAttached: true });
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		expect(harness.activeTools()).not.toContain("subagent");
		harness.pi.setActiveTools(["subagent", "subagent_process"]);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		expect(harness.activeTools()).toEqual(["subagent_process"]);
		harness.attachment!.dispose();
		expect(harness.activeTools()).toContain("subagent");
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
	});

	test("late attachment publisher gates a previously captured native tool", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const stale = harness.tools.get("subagent");
		const attachment = publishSwarmAttachment(harness.pi as any, true);
		await expect(stale.execute("stale", { task: "bypass" }, undefined, undefined, harness.ctx)).rejects.toThrow("disabled");
		expect(harness.invocations).toHaveLength(0);
		attachment.set(true);
		expect(harness.activeTools()).not.toContain("subagent");
		attachment.dispose();
		expect(harness.activeTools()).toContain("subagent");
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
	});

	test("detachment does not enable a direct tool that was already inactive", async () => {
		const harness = createHarness();
		harness.pi.setActiveTools(["subagent_process"]);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const attachment = publishSwarmAttachment(harness.pi as any, true);
		attachment.dispose();
		expect(harness.activeTools()).toEqual(["subagent_process"]);
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
	});
	test("registers native tools and cleans up children on shutdown", async () => {
		const harness = createHarness();
		expect([...harness.tools.keys()]).toEqual(["subagent", "subagent_process"]);
		const result = await harness.tools.get("subagent").execute("start", { task: "Native child" }, undefined, undefined, harness.ctx);
		expect(result.content[0].text).toContain("Started sub_1");
		expect(result.details.job.cwd).toBe(harness.ctx.cwd);
		expect(harness.invocations[0].args).toContain(new URL("../bg-bash/index.ts", import.meta.url).pathname);
		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
		expect(harness.children[0].killedWith).toContain("SIGTERM");
	});

	test("blocks creation while attached to a swarm and keeps process management available", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		let attached = true;
		harness.pi.events.on(SWARM_ATTACHMENT_QUERY_EVENT, (query: { attached: boolean }) => { query.attached = attached; });
		harness.emitEvent(SWARM_ATTACHMENT_CHANGED_EVENT, { attached });

		expect(harness.activeTools()).not.toContain("subagent");
		expect(harness.activeTools()).toContain("subagent_process");
		await expect(harness.tools.get("subagent").execute("stale", { task: "bypass" }, undefined, undefined, harness.ctx)).rejects.toThrow("disabled");
		expect(harness.invocations).toHaveLength(0);

		attached = false;
		harness.emitEvent(SWARM_ATTACHMENT_CHANGED_EVENT, { attached });
		expect(harness.activeTools()).toContain("subagent");
	});

	test("returns immediately with inherited model and auto-delivers completion", async () => {
		const harness = createHarness();
		const result = await harness.tools.get("subagent").execute(
			"start",
			{ task: "inspect auth" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(result.details.job).toMatchObject({ id: "sub_1", status: "running" });
		expect(harness.tools.get("subagent").parameters.properties).not.toHaveProperty("timeoutSeconds");
		expect(harness.invocations[0].args).toContain("--no-extensions");
		expect(harness.invocations[0].args).toContain("test-provider/test-model");
		expect(harness.invocations[0].args).not.toContain("--tools");
		const extensionIndex = harness.invocations[0].args.indexOf("--extension");
		expect(harness.invocations[0].args[extensionIndex + 1]).toBe(new URL("../pi-codex-conversion/index.ts", import.meta.url).pathname);

		harness.children[0].stdout.write(assistantEvent("auth report"));
		harness.children[0].emit("close", 0);
		await Bun.sleep(1);

		expect(harness.messages).toHaveLength(1);
		expect(harness.messages[0].message.content).toContain("auth report");
		expect(harness.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(harness.emitted.find(({ event }) => event?.source === "subagent")?.event).toMatchObject({ source: "subagent", id: "sub_1", status: "exited" });
		const output = await harness.tools.get("subagent_process").execute("output", { action: "output", id: "sub_1" });
		expect(output.details.jobs[0].usage).toMatchObject({ input: 10, output: 5, turns: 1 });
	});

	test("marks model errors as failed and includes diagnostics", async () => {
		const harness = createHarness();
		await harness.tools.get("subagent").execute("start", { task: "fail" }, undefined, undefined, harness.ctx);
		harness.children[0].stdout.write(assistantEvent("partial", { stopReason: "error", errorMessage: "quota exceeded" }));
		harness.children[0].emit("close", 0);
		await Bun.sleep(1);

		expect(harness.messages[0].message.content).toContain("quota exceeded");
		expect(harness.emitted.find(({ event }) => event?.source === "subagent")?.event.status).toBe("failed");
	});

	test("kills jobs explicitly and suppresses delivery during session cleanup", async () => {
		const explicit = createHarness();
		await explicit.tools.get("subagent").execute("start", { task: "long" }, undefined, undefined, explicit.ctx);
		const killed = await explicit.tools.get("subagent_process").execute("kill", { action: "kill", id: "sub_1" });
		expect(killed.details.jobs[0].status).toBe("killed");
		expect(explicit.children[0].killedWith).toContain("SIGTERM");

		const cleanup = createHarness();
		await cleanup.tools.get("subagent").execute("start", { task: "longer" }, undefined, undefined, cleanup.ctx);
		await cleanup.handlers.get("session_shutdown")?.({}, {});
		expect(cleanup.children[0].killedWith).toContain("SIGTERM");
		expect(cleanup.messages).toHaveLength(0);
	});

	test("reports event-derived activity without retaining tool payloads", async () => {
		const harness = createHarness();
		await harness.tools.get("subagent").execute("start", { task: "research" }, undefined, undefined, harness.ctx);
		const child = harness.children[0];
		child.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
		child.stdout.write(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } })}\n`);
		child.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "secret-path" } })}\n`);

		const active = await harness.tools.get("subagent_process").execute("list", { action: "list" });
		expect(active.content[0].text).toContain("elapsed=");
		expect(active.content[0].text).toContain("activity=tool_execution_start tool=read completedTools=0");
		expect(active.content[0].text).not.toContain("secret-path");
		expect(active.details.jobs[0].lastActivityAt).toBeGreaterThanOrEqual(active.details.jobs[0].startedAt);

		child.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "read", result: "secret-result" })}\n`);
		const finishedTool = await harness.tools.get("subagent_process").execute("list", { action: "list" });
		expect(finishedTool.content[0].text).toContain("activity=tool_execution_end completedTools=1");
		expect(finishedTool.content[0].text).not.toContain("secret-result");
	});

	test("does not advertise tool restrictions", () => {
		const harness = createHarness();
		const properties = harness.tools.get("subagent").parameters.properties;
		expect(properties).not.toHaveProperty("write");
		expect(properties).not.toHaveProperty("tools");
	});

	test("finalizes kill after SIGKILL when close never arrives", async () => {
		const harness = createHarness({ closeOnKill: false });
		await harness.tools.get("subagent").execute("start", { task: "stuck" }, undefined, undefined, harness.ctx);
		jest.useFakeTimers();
		try {
			const kill = harness.tools.get("subagent_process").execute("kill", { action: "kill", id: "sub_1" });
			let settled = false;
			void kill.finally(() => { settled = true; });

			expect(harness.children[0].killedWith).toEqual(["SIGTERM"]);
			jest.advanceTimersByTime(1_999);
			await Promise.resolve();
			expect(harness.children[0].killedWith).toEqual(["SIGTERM"]);
			expect(settled).toBe(false);
			jest.advanceTimersByTime(1);
			await Promise.resolve();
			expect(harness.children[0].killedWith).toEqual(["SIGTERM", "SIGKILL"]);
			expect(settled).toBe(false);
			jest.advanceTimersByTime(1_999);
			await Promise.resolve();
			expect(settled).toBe(false);
			jest.advanceTimersByTime(1);
			const killed = await kill;

			expect(killed.details.jobs[0]).toMatchObject({ status: "killed", reason: "killed" });
			expect(killed.details.jobs[0].error).toContain("SIGKILL");
			expect(harness.children[0].killedWith).toEqual(["SIGTERM", "SIGKILL"]);
		} finally {
			jest.useRealTimers();
		}
	});

	test("delivers head and tail and paginates every retained output character", async () => {
		const harness = createHarness();
		await harness.tools.get("subagent").execute("start", { task: "long answer" }, undefined, undefined, harness.ctx);
		const answer = `HEAD-${"x".repeat(120_000)}-TAIL`;
		harness.children[0].stdout.write(assistantEvent(answer));
		harness.children[0].emit("close", 0);
		await Bun.sleep(1);

		expect(harness.messages[0].message.content).toContain("HEAD-");
		expect(harness.messages[0].message.content).toContain("-TAIL");
		expect(harness.messages[0].message.content.length).toBeLessThan(51_000);

		const processTool = harness.tools.get("subagent_process");
		const finalChunk = await processTool.execute("output", { action: "output", id: "sub_1" });
		expect(finalChunk.details.range).toMatchObject({ total: answer.length, end: answer.length, limit: 50_000 });
		expect(finalChunk.details.range.offset).toBe(answer.length - 50_000);
		expect(finalChunk.content[0].text).toContain("-TAIL");

		let reconstructed = "";
		for (let offset = 0; offset < answer.length; offset += 50_000) {
			const chunk = await processTool.execute("output", { action: "output", id: "sub_1", offset, limit: 50_000 });
			const prefix = `${chunk.content[0].text.split("\n\n")[0]}\n\n`;
			reconstructed += chunk.content[0].text.slice(prefix.length);
		}
		expect(reconstructed).toBe(answer);
	});

	test("bounds malformed stdout diagnostics and exposes them through output", async () => {
		const harness = createHarness();
		await harness.tools.get("subagent").execute("start", { task: "protocol" }, undefined, undefined, harness.ctx);
		const malformedTail = "bad-tail";
		harness.children[0].stdout.write(`${"z".repeat(60_000)}${malformedTail}\n`);
		harness.children[0].stdout.write("null\n");
		harness.children[0].stdout.write(assistantEvent("final answer"));
		harness.children[0].emit("close", 0);
		await Bun.sleep(1);

		const output = await harness.tools.get("subagent_process").execute("output", { action: "output", id: "sub_1" });
		const job = output.details.jobs[0];
		expect(job.protocolDiagnostics.length).toBeLessThanOrEqual(50_000);
		expect(job.protocolDiagnostics).toContain(malformedTail);
		expect(job.protocolDiagnostics).toContain("null");
		const diagnosticsStart = await harness.tools.get("subagent_process").execute(
			"output",
			{ action: "output", id: "sub_1", offset: 0, limit: 100 },
		);
		expect(diagnosticsStart.content[0].text).toContain("Protocol diagnostics:");
		expect(output.content[0].text).toContain("final answer");
	});

	test("throws process-tool errors for invalid ids and pagination", async () => {
		const harness = createHarness();
		const processTool = harness.tools.get("subagent_process");
		await expect(processTool.execute("output", { action: "output" })).rejects.toThrow("id is required");
		await expect(processTool.execute("output", { action: "output", id: "missing" })).rejects.toThrow("Unknown subagent job");
		await harness.tools.get("subagent").execute("start", { task: "running" }, undefined, undefined, harness.ctx);
		await expect(processTool.execute("output", { action: "output", id: "sub_1", offset: -1 })).rejects.toThrow("offset");
		await expect(processTool.execute("output", { action: "output", id: "sub_1", offset: 1.5 })).rejects.toThrow("offset");
		await expect(processTool.execute("output", { action: "output", id: "sub_1", limit: 50_001 })).rejects.toThrow("limit");
		await expect(processTool.execute("output", { action: "output", id: "sub_1", offset: 10_000 })).rejects.toThrow("exceeds retained output");
		await expect(processTool.execute("kill", { action: "kill" })).rejects.toThrow("id is required");
	});
});
