import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMixtureExtension } from "./index.ts";
import type { WorkerResult } from "./runner.ts";

let savedAgentDir: string | undefined;
beforeEach(() => {
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "mixture-index-"));
});
afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

const worker = (model: string, output: string): WorkerResult => ({
	model,
	status: "ok",
	output,
	usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 },
	branch: `pi-mixture/run/${model}`,
	worktree: "/tmp/wt",
});

const harness = (run: any) => {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const messages: any[] = [];
	const pi: any = {
		registerTool: (tool: any) => { tools.set(tool.name, tool); },
		registerCommand: (name: string, command: any) => { commands.set(name, command); },
		on: (event: string, handler: any) => { handlers.set(event, handler); return () => {}; },
		sendMessage: (message: any, options: any) => { messages.push({ message, options }); },
		getThinkingLevel: () => "medium",
		events: { emit() {}, on() { return () => {}; } },
		getAllTools: () => [],
		getActiveTools: () => [],
	};
	createMixtureExtension(pi, run);
	return { tools, commands, handlers, messages };
};

describe("mixture extension", () => {
	test("tool returns rendered outputs for the main thread", async () => {
		const calls: any[] = [];
		const { tools } = harness(async (options: any) => {
			calls.push(options);
			return [worker("openrouter/a", "answer A"), worker("openrouter/b", "answer B")];
		});
		const result = await tools.get("mixture_run").execute("id", { task: "Do it" }, null, null, { cwd: "/tmp", thinkingLevel: "high" });
		expect(calls[0].task).toBe("Do it");
		expect(calls[0].thinking).toBe("high");
		expect(calls[0].cwd).toBe("/tmp");
		expect(result.content[0].text).toContain("answer A");
		expect(result.content[0].text).toContain("answer B");
		expect(result.content[0].text).toContain("combine the best parts");
		expect(result.details.output.succeeded).toBe(2);
	});

	test("tool rejects an empty task before spawning", async () => {
		let spawned = false;
		const { tools } = harness(async () => { spawned = true; return []; });
		await expect(tools.get("mixture_run").execute("id", { task: "  " }, null, null, { cwd: "/tmp" })).rejects.toThrow("task is required");
		expect(spawned).toBe(false);
	});

	test("/mixture sends the result as a steering message", async () => {
		const { commands, messages } = harness(async () => [worker("openrouter/a", "answer A")]);
		const notified: string[] = [];
		await commands.get("mixture").handler("Do it", { cwd: "/tmp", ui: { notify: (text: string) => { notified.push(text); } } });
		expect(messages).toHaveLength(1);
		expect(messages[0].message.content).toContain("answer A");
		expect(messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	});

	test("/mixture without a task notifies usage", async () => {
		let spawned = false;
		const { commands, messages } = harness(async () => { spawned = true; return []; });
		const notified: string[] = [];
		await commands.get("mixture").handler("  ", { cwd: "/tmp", ui: { notify: (text: string) => { notified.push(text); } } });
		expect(spawned).toBe(false);
		expect(messages).toHaveLength(0);
		expect(notified[0]).toContain("Usage: /mixture <task>");
	});
});
