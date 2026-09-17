import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createMixtureExtension } from "./index.ts";
import { ASK_ADVISOR } from "./advisor.ts";
import { defaultAdvisorPreset, MIN_ADVISOR_INTERVAL_MS } from "./config.ts";
import { ManualScheduler } from "../test-scheduler.ts";
import { emitMessage, emptyUsage, requestLaneId, type Registry } from "./provider.ts";

const originalAgent = process.env.PI_CODING_AGENT_DIR;
const dirs: string[] = [];
afterEach(() => {
	if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgent;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const harness = async (config?: string, fast?: boolean, scheduler?: ManualScheduler) => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-index-")); dirs.push(dir); process.env.PI_CODING_AGENT_DIR = dir;
	if (config) writeFileSync(join(dir, "mixture.json"), config);
	const commands = new Map<string, any>(); const handlers = new Map<string, any>(); const providers: Provider[] = []; const tools: string[] = [];
	let activeTools = ["read", "write", "edit", "bash"];
	const roleOptions: Array<SimpleStreamOptions & { serviceTier?: string }> = [];
	const definitions = new Map<string, any>();
	const sentMessages: Array<{ message: any; options: any }> = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
	const releasedIds: string[] = [];
	const selectedModels: Array<{ provider: string; id: string }> = [];
	let calls = 0;
	const registry: Registry = {
		find: (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: emptyUsage().cost }),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (model, _context, options) => {
			calls++; roleOptions.push(options ?? {}); const stream = createAssistantMessageEventStream();
			emitMessage(stream, { role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [{ type: "text", text: "summary" }], usage: emptyUsage(), stopReason: "stop", timestamp: 1 });
			return stream;
		} }) as any,
	};
	const pi = {
		registerCommand: (name: string, value: any) => commands.set(name, value),
		registerTool: (tool: any) => { tools.push(tool.name); definitions.set(tool.name, tool); },
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerProvider: (provider: Provider) => providers.push(provider),
		unregisterProvider: (id: string) => { const index = providers.findIndex(provider => provider.id === id); if (index >= 0) providers.splice(index, 1); },
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => { activeTools = names; },
		events: { emit(name: string, value: { enabled?: boolean; sessionIds?: string[] }) {
			if (name === "fast:query" && fast !== undefined) value.enabled = fast;
			if (name === "tripp:mixture-session-release/v1") releasedIds.push(...value.sessionIds!);
		} },
		sendMessage: (message: any, options: any) => { sentMessages.push({ message, options }); },
		setModel: async (model: { provider: string; id: string }) => { selectedModels.push(model); return true; },
	};
	await createMixtureExtension(pi as any, registry, scheduler ? { scheduler } : {});
	return { dir, commands, handlers, providers, tools, definitions, registry, roleOptions, releasedIds, selectedModels, sentMessages, statusUpdates, get activeTools() { return activeTools; }, get calls() { return calls; } };
};
test("factory registers a native model without starting inference or old tools", async () => {
	const h = await harness();
	expect(h.providers).toHaveLength(1);
	expect(h.providers[0].getModels()[0].id).toBe("default");
	expect(h.calls).toBe(0);
	expect(h.tools).not.toContain("mixture_run");
	expect(h.tools).not.toContain("mixture_process");
	await h.handlers.get("session_start")({}, { modelRegistry: h.registry, thinkingLevel: "high", model: { provider: "ordinary" }, ui: { notify() {} } });
	expect(h.calls).toBe(0);
});
test("advisor mode is a selectable Mixture model whose executor owns tools and consults its configured advisor", async () => {
	const preset = defaultAdvisorPreset();
	preset.executor = { model: "fixture/executor", thinking: "medium" };
	preset.advisor = { model: "fixture/advisor", thinking: "high" };
	const h = await harness(JSON.stringify({ version: 3, presets: { advisor: preset } }));
	const branch: any[] = [{ type: "message", message: { role: "user", content: "Check the fixture" } }];
	const context = {
		cwd: h.dir, modelRegistry: h.registry, thinkingLevel: "max", model: { provider: "mixture", id: "advisor" }, hasUI: true,
		sessionManager: { getSessionId: () => "advisor-root", getBranch: () => branch, getEntries: () => branch },
		isIdle: () => false, hasPendingMessages: () => false,
		getSystemPrompt: () => "Base prompt", ui: { notify() {}, setStatus(key: string, value: string | undefined) { h.statusUpdates.push({ key, value }); } },
	};
	await h.handlers.get("session_start")({}, context);
	expect(h.statusUpdates.at(-1)).toEqual({ key: "mixture", value: "executor · advisor 0" });
	expect(h.activeTools).toContain(ASK_ADVISOR);
	expect(h.activeTools).not.toContain("mixture_control");
	const provider = h.providers[0];
	const output = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "Execute", timestamp: 1 }], tools: [] }, { sessionId: "advisor-root" }).result();
	expect(output.model).toBe("executor");
	expect(h.roleOptions[0].reasoning).toBe("medium");
	const prompt = await h.handlers.get("before_agent_start")({ prompt: "Execute" }, context);
	expect(prompt.systemPrompt).toContain("Mixture advisor mode");
	expect(prompt.systemPrompt).toContain("must call ask_advisor at least once");
	expect(prompt.systemPrompt).toContain("every 5 minutes");
	expect(prompt.systemPrompt).toContain("after two materially equivalent failed attempts");
	const tool = h.definitions.get(ASK_ADVISOR);
	const call = { toolCallId: "advisor-call", toolName: ASK_ADVISOR, input: {} };
	expect(h.handlers.get("tool_call")(call, context)).toBeUndefined();
	expect(h.handlers.get("tool_call")({ toolCallId: "advisor-call-too-soon", toolName: ASK_ADVISOR, input: {} }, context)).toMatchObject({ block: true, reason: expect.stringContaining("throttled") });
	const advice = await tool.execute("advisor-call", {}, undefined, undefined, context);
	expect(advice.content[0].text).toBe("summary");
	expect(advice.details.model).toBe("fixture/advisor");
	expect(h.roleOptions[1].reasoning).toBe("high");
	expect(h.roleOptions[1].maxTokens).toBe(4_096);
	await h.handlers.get("agent_end")({ messages: [] });
	expect(h.releasedIds).toEqual([h.roleOptions[1].sessionId, h.roleOptions[0].sessionId]);
	// Keep the composite newer than the underlying Executor message for Pi's resume lookup.
	expect(h.selectedModels).toEqual([{ provider: "mixture", id: "advisor" }]);
	await h.handlers.get("model_select")({}, { ...context, model: { provider: "fixture", id: "ordinary" } });
	await h.handlers.get("agent_end")({ messages: [] });
	expect(h.selectedModels).toHaveLength(1);
	expect(h.activeTools).not.toContain(ASK_ADVISOR);
});

test("advisor mode nudges the Executor on its configured five-minute cadence", async () => {
	const scheduler = new ManualScheduler();
	const preset = defaultAdvisorPreset();
	preset.executor = { model: "fixture/executor", thinking: "medium" };
	preset.advisor = { model: "fixture/advisor", thinking: "high" };
	const h = await harness(JSON.stringify({ version: 3, presets: { advisor: preset } }), undefined, scheduler);
	const branch: any[] = [{ type: "message", message: { role: "user", content: "Keep working" } }];
	const context = {
		cwd: h.dir, modelRegistry: h.registry, thinkingLevel: "max", model: { provider: "mixture", id: "advisor" }, hasUI: true,
		sessionManager: { getSessionId: () => "advisor-root", getBranch: () => branch, getEntries: () => branch },
		isIdle: () => false, hasPendingMessages: () => false,
		getSystemPrompt: () => "Base prompt", ui: { notify() {}, setStatus(key: string, value: string | undefined) { h.statusUpdates.push({ key, value }); } },
	};
	await h.handlers.get("session_start")({}, context);
	await h.handlers.get("before_agent_start")({ prompt: "Keep working" }, context);
	await h.handlers.get("agent_start")();
	await scheduler.advanceBy(299_999);
	expect(h.sentMessages).toHaveLength(0);
	await scheduler.advanceBy(1);
	expect(h.sentMessages).toHaveLength(1);
	expect(h.sentMessages[0].message.content).toContain("ask_advisor");
	expect(h.sentMessages[0].options).toEqual({ deliverAs: "steer" });
	await h.handlers.get("agent_end")({ messages: [] });
	await scheduler.advanceBy(300_000);
	expect(h.sentMessages).toHaveLength(1);
});

const advisorHarness = async () => {
	const scheduler = new ManualScheduler();
	const preset = defaultAdvisorPreset();
	preset.limits.advisorIntervalMs = 180_000;
	preset.context.git = "off";
	preset.advisor.model = "fixture/advisor";
	const h = await harness(JSON.stringify({ version: 3, presets: { advisor: preset } }), undefined, scheduler);
	const branch: any[] = [];
	const context = {
		cwd: h.dir, modelRegistry: h.registry, model: { provider: "mixture", id: "advisor" },
		sessionManager: { getSessionId: () => "root", getBranch: () => branch, getEntries: () => branch },
		isIdle: () => false, hasPendingMessages: () => false, ui: { notify() {} },
	};
	await h.handlers.get("session_start")({}, context);
	await h.handlers.get("agent_start")();
	return { ...h, scheduler, context, branch };
};

test("consulting just before a tick restarts the full interval and reminders cannot accumulate", async () => {
	const h = await advisorHarness();
	await h.scheduler.advanceBy(170_000);
	h.handlers.get("tool_call")({ toolCallId: "review", toolName: ASK_ADVISOR });
	await h.definitions.get(ASK_ADVISOR).execute("review", {}, undefined, undefined, h.context);
	await h.scheduler.advanceBy(179_999);
	expect(h.sentMessages).toHaveLength(0);
	await h.scheduler.advanceBy(1);
	expect(h.sentMessages).toHaveLength(1);
	await h.scheduler.advanceBy(900_000);
	expect(h.sentMessages).toHaveLength(1);
	const reminder = { role: "custom", ...h.sentMessages[0].message };
	expect(h.handlers.get("context")({ messages: [reminder] }).messages).toEqual([reminder]);
	h.handlers.get("tool_call")({ toolCallId: "review-again", toolName: ASK_ADVISOR });
	expect(h.handlers.get("context")({ messages: [reminder] }).messages).toEqual([]);
});

for (const transition of ["agent_end", "session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown", "model_select"])
	test(`advisor cancels reminders on ${transition}`, async () => {
		const h = await advisorHarness();
		await h.handlers.get(transition)({}, { ...h.context, model: { provider: "fixture", id: "other" } });
		await h.scheduler.advanceBy(900_000);
		expect(h.sentMessages).toHaveLength(0);
	});

test("resumed advisor sessions use wall-clock timestamps for persisted cooldowns", async () => {
	const h = await advisorHarness();
	h.branch.push({ type: "message", message: { role: "toolResult", toolName: ASK_ADVISOR, timestamp: Date.now() - MIN_ADVISOR_INTERVAL_MS - 1 } });
	expect(h.handlers.get("tool_call")({ toolCallId: "expired", toolName: ASK_ADVISOR })).toBeUndefined();
});

test("session transitions clear the previous session's in-memory cooldown", async () => {
	const h = await advisorHarness();
	const call = { toolCallId: "first", toolName: ASK_ADVISOR };
	expect(h.handlers.get("tool_call")(call)).toBeUndefined();
	expect(h.handlers.get("tool_call")({ ...call, toolCallId: "blocked" })).toMatchObject({ block: true });
	await h.handlers.get("session_before_switch")({});
	await h.handlers.get("session_start")({}, { ...h.context, sessionManager: { ...h.context.sessionManager, getSessionId: () => "next-root" } });
	expect(h.handlers.get("tool_call")({ ...call, toolCallId: "next" })).toBeUndefined();
});

for (const outcome of ["error", "aborted"] as const) test(`advisor ${outcome} releases its exact provider session and backs off`, async () => {
	const h = await advisorHarness();
	h.registry.getProvider = () => ({ streamSimple: (model: any) => {
		const stream = createAssistantMessageEventStream();
		emitMessage(stream, { role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [], usage: emptyUsage(), stopReason: outcome, errorMessage: outcome, timestamp: 1 });
		return stream;
	} }) as any;
	await expect(h.definitions.get(ASK_ADVISOR).execute("failed", {}, undefined, undefined, h.context)).rejects.toThrow(outcome);
	expect(h.releasedIds).toHaveLength(1);
	expect(h.releasedIds[0]).toBe(requestLaneId("root", "advisor", "fixture/advisor", "ordinary"));
	await h.scheduler.advanceBy(179_999);
	expect(h.sentMessages).toHaveLength(0);
	await h.scheduler.advanceBy(1);
	expect(h.sentMessages).toHaveLength(1);
	await h.handlers.get("agent_end")({});
	expect(h.releasedIds).toHaveLength(1);
});

test("model transition aborts an in-flight advisor and releases once without restarting reminders", async () => {
	const h = await advisorHarness();
	let started!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	let signal: AbortSignal | undefined;
	h.registry.getProvider = () => ({ streamSimple: (_model: any, _context: any, options: any) => {
		signal = options.signal;
		started();
		return createAssistantMessageEventStream();
	} }) as any;
	const result = h.definitions.get(ASK_ADVISOR).execute("pending", {}, undefined, undefined, h.context);
	const rejected = result.catch((error: unknown) => error);
	await ready;
	await h.handlers.get("model_select")({}, { ...h.context, model: { provider: "fixture", id: "other" } });
	expect(await rejected).toBeInstanceOf(Error);
	expect(signal?.aborted).toBe(true);
	expect(h.releasedIds).toHaveLength(1);
	await h.handlers.get("session_shutdown")({});
	expect(h.releasedIds).toHaveLength(1);
	await h.scheduler.advanceBy(900_000);
	expect(h.sentMessages).toHaveLength(0);
});

test("native Pi rows preserve lead previews through streaming, expansion and history rebuilds", async () => {
	initTheme("dark", false);
	const h = await harness();
	const args = { action: "delegate", task: "Repair the fixture", nextAction: `Fix the known defect. ${"Check the edge case. ".repeat(20)}FINAL_ACTION_DETAIL`, constraints: ["Keep unrelated edits"] };
	const result = { role: "toolResult", toolCallId: "preview", toolName: "mixture_control", content: [{ type: "text", text: "Delegated to writer.\nFull result details." }], details: { usageSummary: "Per-role usage detail" }, isError: false };
	const call = (arguments_: any) => ({ role: "assistant", content: [{ type: "toolCall", id: "preview", name: "mixture_control", arguments: arguments_ }], stopReason: "toolUse" });
	const mode = {
		chatContainer: new Container(), pendingTools: new Map(), toolOutputExpanded: false,
		settingsManager: { getShowCacheMissNotices: () => false, getShowImages: () => false, getImageWidthCells: () => 60 },
		sessionManager: { getCwd: () => h.dir }, ui: { requestRender() {} },
		getRegisteredToolDefinition: (name: string) => h.definitions.get(name),
		addMessageToChat() {}, maybeShowAssistantDiagnostics() {},
	};
	const rebuild = (entries: any[]) => {
		mode.chatContainer.clear();
		(InteractiveMode.prototype as any).renderSessionItems.call(mode, entries);
	};
	const output = () => stripVTControlCharacters(mode.chatContainer.render(240).join("\n"));
	rebuild([call({ action: "delegate", nextAction: "Fix the" })]);
	expect(output()).toContain("Fix the");
	const component = mode.pendingTools.get("preview");
	component.updateArgs(args); component.setArgsComplete(); component.markExecutionStarted();
	component.updateResult(result);
	expect(output()).toContain("Fix the known defect.");
	expect(output()).toContain("Delegated to writer.");
	expect(output()).not.toContain("FINAL_ACTION_DETAIL");
	expect(output()).not.toContain("Per-role usage detail");
	component.setExpanded(true);
	expect(output()).toContain("FINAL_ACTION_DETAIL");
	expect(output()).toContain("Keep unrelated edits");
	expect(output()).not.toContain("Per-role usage detail");
	expect(output()).toContain("Full result details.");
	component.setExpanded(false);
	expect(output()).not.toContain("FINAL_ACTION_DETAIL");
	for (let reload = 0; reload < 2; reload++) {
		rebuild([call(args), result]);
		expect(output()).toContain("Fix the known defect.");
		expect(output()).toContain("Delegated to writer.");
		expect(output()).not.toContain("FINAL_ACTION_DETAIL");
		expect(mode.chatContainer.render(24).every(line => visibleWidth(line) <= 24)).toBe(true);
	}
	rebuild([call(args), { ...result, isError: true, content: [{ type: "text", text: "Rejected: writer lease is still held." }] }]);
	expect(output()).toContain("Rejected: writer lease is still held.");
	expect(h.calls).toBe(0);
});

test("invalid config retains commands but registers no provider and writes no replacement", async () => {
	const h = await harness('{"models":["old/model"]}');
	expect(h.providers).toHaveLength(0);
	const notices: string[] = [];
	await h.commands.get("mixture").handler("status", { ui: { notify: (text: string) => notices.push(text) } });
	expect(notices[0]).toContain("version 3");
	expect(notices[0]).toContain("mixture.json");
});
test("helper calls use the lead only and return an ordinary assistant result", async () => {
	const h = await harness();
	const provider = h.providers[0];
	const result = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "Summarize", timestamp: 1 }] }, { reasoning: "high", sessionId: "helper" }).result();
	expect(result.content).toEqual([{ type: "text", text: "summary" }]);
	expect(h.calls).toBe(1);
	expect(h.roleOptions[0].serviceTier).toBeUndefined();
	expect(result.provider).toBe("openai-codex");
	expect(h.releasedIds).toEqual([h.roleOptions[0].sessionId!]);
});
test("role requests inherit explicit session fast mode", async () => {
	for (const [fast, serviceTier] of [[true, "priority"], [false, "default"]] as const) {
		const h = await harness(undefined, fast);
		const provider = h.providers[0];
		await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "Summarize", timestamp: 1 }] }, { sessionId: "helper" }).result();
		expect(h.roleOptions[0].serviceTier).toBe(serviceTier);
	}
});
for (const outcome of ["save", "cancel", "conflict"] as const) test(`configure ${outcome} preserves the explicit save boundary`, async () => {
	const original = '{"models":["old/model"]}';
	const h = await harness(original);
	const path = join(h.dir, "mixture.json");
	const notices: string[] = [];
	await h.commands.get("mixture").handler("configure", {
		hasUI: true, isIdle: () => true,
		modelRegistry: { ...h.registry, getAvailable: () => [h.registry.find("fixture", "lead")] },
		ui: {
			select: async (label: string, options: string[]) => label === "Independent reviewers" ? "0" : options[0],
			editor: async (_label: string, value: string) => value,
			confirm: async () => { if (outcome === "conflict") writeFileSync(path, "human changed this"); return outcome !== "cancel"; },
			notify: (text: string) => notices.push(text),
		},
	});
	const contents = readFileSync(path, "utf8");
	if (outcome === "save") {
		expect(JSON.parse(contents)).toMatchObject({ version: 3, presets: { default: { lead: "fixture/lead", reviewers: [] } } });
		expect(h.providers).toHaveLength(1);
		expect(notices[0]).toContain("Saved");
	} else {
		expect(contents).toBe(outcome === "cancel" ? original : "human changed this");
		expect(h.providers).toHaveLength(0);
		if (outcome === "conflict") expect(notices[0]).toContain("changed");
	}
	expect(h.calls).toBe(0);
});
