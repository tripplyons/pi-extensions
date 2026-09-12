import { expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { getCodeModeExtensionToolSnapshot } from "@howaboua/pi-codex-conversion/dist/code-mode-extension-tools.js";
import { createMixtureExtension } from "./index.ts";
import { emptyUsage, type Run } from "./state.ts";

let savedAgentDir: string | undefined;
let savedStateDir: string | undefined;
let directory: string;
const shutdowns: (() => void)[] = [];
beforeEach(() => {
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	savedStateDir = process.env.PI_MIXTURE_HOME;
	directory = mkdtempSync(join(tmpdir(), "mixture-index-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	process.env.PI_MIXTURE_HOME = join(directory, "state");
});
afterEach(() => {
	for (const stop of shutdowns.splice(0)) stop();
	rmSync(directory, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	if (savedStateDir === undefined) delete process.env.PI_MIXTURE_HOME;
	else process.env.PI_MIXTURE_HOME = savedStateDir;
});

function harness(entries: any[] = []) {
	const run: Run = {
		schemaVersion: 1, id: "mix_test", ownerSession: "root", createdAt: 1, updatedAt: 1, supervisorPid: 0,
		options: { task: "test", models: ["model"], timeoutMs: 1000, thinking: "medium", cwd: "/repo" },
		workers: [{ id: "slot-0", model: "model", cwd: "/retained", attempts: [] }], commands: [],
	};
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const messages: any[] = [];
	const calls: any[] = [];
	const notifications: string[] = [];
	let active = ["exec", "unrelated", "mixture_run", "mixture_process"];
	let reconnects = 0;
	const events = new EventEmitter();
	const ctx: any = { cwd: "/repo", sessionManager: { getSessionId: () => "root", getEntries: () => entries },
		ui: { notify: (text: string) => notifications.push(text) } };
	const pi: any = {
		registerMessageRenderer() {},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (event: string, handler: any) => { handlers.set(event, handler); return () => {}; },
		sendMessage: (message: any, options: any) => {
			messages.push({ message, options });
			entries.push({ type: "custom_message", ...message });
		},
		getThinkingLevel: () => "high",
		events: {
			emit: (name: string, value: unknown) => events.emit(name, value),
			on: (name: string, handler: (...args: any[]) => void) => { events.on(name, handler); return () => events.off(name, handler); },
		},
		getAllTools: () => [...tools.values()], getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
	};
	createMixtureExtension(pi, {
		reconnectRuns: () => { reconnects++; },
		startRun: (options, owner) => { calls.push({ options, owner }); return run; },
		readRun: () => run,
		sessionRuns: (session) => session === run.ownerSession ? [run] : [],
		commandRun: (...args) => { calls.push(args); return { runId: run.id, requestId: "cmd_test", status: "pending", message: "queued" }; },
	});
	shutdowns.push(() => handlers.get("session_shutdown")());
	const execute = (name: string, params: unknown) => tools.get(name).execute("id", params, undefined, undefined, ctx);
	handlers.get("session_start")({}, ctx);
	return { run, calls, messages, handlers, commands, notifications, ctx, execute,
		toggle: () => commands.get("mixture").handler("", ctx),
		codeTools: () => getCodeModeExtensionToolSnapshot(pi, ctx, true).tools.map(tool => tool.name),
		get active() { return active; }, get reconnects() { return reconnects; },
	};
}

test("start returns queued identity without waiting for model output", async () => {
	const h = harness();
	await h.toggle();
	const result = await h.execute("mixture_run", { task: " Do it ", timeoutMs: 500 });
	expect(h.calls[0].owner).toBe("root");
	expect(h.calls[0].options).toMatchObject({ task: "Do it", thinking: "high", cwd: "/repo", timeoutMs: 500 });
	expect(JSON.parse(result.content[0].text).workers[0].status).toBe("queued");
	expect(result.details.stateFile).toEndWith("mix_test/run.json");
});

test("invalid calls do not reach the client", async () => {
	const h = harness();
	await h.toggle();
	await expect(h.execute("mixture_run", { task: " " })).rejects.toThrow("task is required");
	await expect(h.execute("mixture_process", { action: "stop" })).rejects.toThrow("runId is required");
	await expect(h.execute("mixture_process", { action: "send", runId: "mix_test" })).rejects.toThrow("workerId is required");
	await expect(h.execute("mixture_process", { action: "send", runId: "mix_test", workerId: "slot-0" })).rejects.toThrow("message is required");
	expect(h.calls).toHaveLength(0);
});

test("root forwards steering, stop, restart and explicit resume", async () => {
	const h = harness();
	await h.toggle();
	for (const action of ["send", "stop", "restart", "resume"]) {
		const result = await h.execute("mixture_process", { action, runId: "mix_test", workerId: "slot-0", message: "use red" });
		expect(JSON.parse(result.content[0].text).requestId).toBe("cmd_test");
		expect(h.calls.at(-1)).toEqual(["mix_test", "root", action, "slot-0", "use red"]);
	}
	expect(JSON.parse((await h.execute("mixture_process", { action: "list" })).content[0].text)[0].id).toBe("mix_test");
	const listing = await h.execute("mixture_process", { action: "list" });
	expect(JSON.parse(readFileSync(listing.details.stateFile, "utf8"))[0].id).toBe("mix_test");
	expect(JSON.parse((await h.execute("mixture_process", { action: "inspect", runId: "mix_test" })).content[0].text).workers[0].cwd).toBe("/retained");
});

test("reconnect delivers retained completions only after enabling, once", async () => {
	const entries: any[] = [];
	const h = harness(entries);
	h.run.workers[0].attempts.push({ attempt: 1, status: "failed", startedAt: 1, finishedAt: 2,
		output: "partial answer", error: "timeout upstream", usage: emptyUsage(), logFile: "/log", sessionFile: "/session" });
	h.handlers.get("session_start")({}, h.ctx);
	expect(h.messages).toHaveLength(0);
	await h.toggle();
	expect(h.messages).toHaveLength(1);
	expect(h.messages[0].message.content).toContain("partial answer");
	expect(h.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	h.handlers.get("session_shutdown")();
	const reopened = harness(entries);
	reopened.run.workers = h.run.workers;
	reopened.handlers.get("session_start")({}, reopened.ctx);
	await reopened.toggle();
	expect(reopened.messages).toHaveLength(0);
	expect(h.calls).toHaveLength(0);
});

test("slash command toggles both tool sets without launching work", async () => {
	const h = harness();
	expect(h.active).toEqual(["exec", "unrelated"]);
	expect(h.codeTools()).toEqual([]);
	expect(h.reconnects).toBe(0);
	await expect(h.execute("mixture_run", { task: "Do it" })).rejects.toThrow("disabled");
	await expect(h.execute("mixture_process", { action: "list" })).rejects.toThrow("disabled");
	await h.toggle();
	expect(h.active).toEqual(["exec", "unrelated", "mixture_run", "mixture_process"]);
	expect(h.codeTools()).toEqual(["mixture_run", "mixture_process"]);
	expect(h.notifications).toEqual(["Mixture enabled"]);
	await h.toggle();
	expect(h.active).toEqual(["exec", "unrelated"]);
	expect(h.codeTools()).toEqual([]);
	await expect(h.execute("mixture_process", { action: "stop", runId: "mix_test" })).rejects.toThrow("disabled");
	expect(h.calls).toHaveLength(0);
	expect(h.messages).toHaveLength(0);
});

test("task arguments do not launch work or toggle enablement", async () => {
	const h = harness();
	await h.commands.get("mixture").handler("Do it", h.ctx);
	expect(h.notifications.at(-1)).toContain("Usage:");
	expect(h.calls).toHaveLength(0);
	expect(h.codeTools()).toEqual([]);
});

test("session startup resets enablement and pending completions wait while disabled", async () => {
	const h = harness();
	await h.toggle();
	h.handlers.get("session_start")({}, h.ctx);
	expect(h.codeTools()).toEqual([]);
	h.run.workers[0].attempts.push({ attempt: 1, status: "ok", startedAt: 1, finishedAt: 2,
		output: "done", usage: emptyUsage(), logFile: "/log", sessionFile: "/session" });
	await Bun.sleep(1100);
	expect(h.messages).toHaveLength(0);
	await h.toggle();
	expect(h.messages).toHaveLength(1);
	await h.toggle();
	await h.toggle();
	expect(h.messages).toHaveLength(1);
});
