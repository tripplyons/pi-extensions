import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { createAssistantMessageEventStream, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createMixtureExtension } from "./index.ts";
import { ADVISOR_BLOCKED_DETAIL, ADVISOR_PREFLIGHT_DETAIL, ADVISOR_PREFLIGHT_MESSAGE, ADVISOR_PREFLIGHT_USAGE_ENTRY, ASK_ADVISOR, advisorCallCount, advisorCost } from "./advisor.ts";
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
	const roleModels: string[] = [];
	const roleContexts: any[] = [];
	const definitions = new Map<string, any>();
	const sentMessages: Array<{ message: any; options: any }> = [];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
	const releasedIds: string[] = [];
	const selectedModels: Array<{ provider: string; id: string }> = [];
	let calls = 0;
	const registry: Registry = {
		find: (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: emptyUsage().cost }),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (model, context, options) => {
			calls++; roleModels.push(model.id); roleContexts.push(context); roleOptions.push(options ?? {}); const stream = createAssistantMessageEventStream();
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
		appendEntry: (customType: string, data: unknown) => { appendedEntries.push({ customType, data }); },
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
	return { dir, commands, handlers, providers, tools, definitions, registry, roleOptions, roleModels, roleContexts, releasedIds, selectedModels, sentMessages, statusUpdates, appendedEntries, get activeTools() { return activeTools; }, get calls() { return calls; } };
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
test("advisor preflight reviews the request before the Executor and persists one review record", async () => {
	const preset = defaultAdvisorPreset();
	preset.executor = { model: "fixture/executor", thinking: "medium" };
	preset.advisor = { model: "fixture/advisor", thinking: "high" };
	const h = await harness(JSON.stringify({ version: 3, presets: { advisor: preset } }));
	const branch: any[] = [];
	const context = {
		cwd: h.dir, modelRegistry: h.registry, thinkingLevel: "max", model: { provider: "mixture", id: "advisor" }, hasUI: true,
		sessionManager: { getSessionId: () => "advisor-root", getBranch: () => branch, getEntries: () => branch },
		isIdle: () => false, hasPendingMessages: () => false,
		getSystemPrompt: () => "Base prompt", ui: { notify() {}, setStatus(key: string, value: string | undefined) { h.statusUpdates.push({ key, value }); } },
	};
	await h.handlers.get("session_start")({}, context);
	const preflight = await h.handlers.get("before_agent_start")({ prompt: "Fix the parser without changing the public API" }, context);
	expect(h.roleModels).toEqual(["advisor"]);
	expect(h.roleContexts[0].messages[0].content).toContain("Fix the parser without changing the public API");
	expect(preflight.message.customType).toBe(ADVISOR_PREFLIGHT_MESSAGE);
	expect(preflight.message.content).toContain("Advisor preflight");
	expect(preflight.message.content).toContain("summary");
	expect(preflight.message.details).toMatchObject({ [ADVISOR_PREFLIGHT_DETAIL]: true, status: "complete", sessionId: "advisor-root", preset: "advisor" });
	branch.push({ type: "custom_message", customType: preflight.message.customType, content: preflight.message.content, display: true, details: preflight.message.details });
	expect(advisorCallCount(branch)).toBe(1);
	expect(advisorCost(branch)).toBe(0);
	expect(preflight.systemPrompt).toContain("automatic Advisor preflight has already reviewed this request");
	const provider = h.providers[0];
	const output = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "Fix", timestamp: 1 }], tools: [] }, { sessionId: "advisor-root" }).result();
	expect(h.roleModels).toEqual(["advisor", "executor"]);
	expect(output.model).toBe("executor");
});
test("advisor preflight skips a recent review without blocking the Executor", async () => {
	const preset = defaultAdvisorPreset();
	preset.executor = { model: "fixture/executor", thinking: "medium" };
	preset.advisor = { model: "fixture/advisor", thinking: "high" };
	const h = await harness(JSON.stringify({ version: 3, presets: { advisor: preset } }));
	const details = {
		[ADVISOR_PREFLIGHT_DETAIL]: true as const, callId: "recent", status: "complete" as const,
		sessionId: "advisor-root", preset: "advisor", completedAt: Date.now(), usage: emptyUsage(),
	};
	const branch: any[] = [{ type: "custom_message", customType: ADVISOR_PREFLIGHT_MESSAGE, details }];
	const context = {
		cwd: h.dir, modelRegistry: h.registry, thinkingLevel: "max", model: { provider: "mixture", id: "advisor" }, hasUI: true,
		sessionManager: { getSessionId: () => "advisor-root", getBranch: () => branch, getEntries: () => branch },
		isIdle: () => false, hasPendingMessages: () => false, ui: { notify() {}, setStatus() {} },
		getSystemPrompt: () => "Base prompt",
	};
	await h.handlers.get("session_start")({}, context);
	const preflight = await h.handlers.get("before_agent_start")({ prompt: "Continue the parser task" }, context);
	expect(h.roleModels).toEqual([]);
	expect(preflight.message.details).toMatchObject({ status: "skipped" });
	expect(preflight.systemPrompt).toContain("preflight was skipped");
	const provider = h.providers[0];
	const output = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "Continue", timestamp: 1 }], tools: [] }, { sessionId: "advisor-root" }).result();
	expect(h.roleModels).toEqual(["executor"]);
	expect(output.model).toBe("executor");
});
test("advisor preflight failure is visible and still lets the Executor start", async () => {
	const preset = defaultAdvisorPreset();
	preset.executor = { model: "fixture/executor", thinking: "medium" };
	preset.advisor = { model: "fixture/advisor", thinking: "high" };
	const h = await harness(JSON.stringify({ version: 3, presets: { advisor: preset } }));
	const originalProvider = h.registry.getProvider;
	h.registry.getProvider = () => ({ streamSimple: (model: any, context: any, options: any) => {
		if (model.id !== "advisor") return originalProvider()!.streamSimple(model, context, options);
		h.roleModels.push(model.id); h.roleContexts.push(context); h.roleOptions.push(options ?? {});
		const stream = createAssistantMessageEventStream();
		emitMessage(stream, { role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [], usage: { ...emptyUsage(), input: 4, cost: { ...emptyUsage().cost, input: 0.004, total: 0.004 } }, stopReason: "error", errorMessage: "fixture failure", timestamp: 1 });
		return stream;
	} }) as any;
	const branch: any[] = [];
	const notices: string[] = [];
	const context = {
		cwd: h.dir, modelRegistry: h.registry, thinkingLevel: "max", model: { provider: "mixture", id: "advisor" }, hasUI: true,
		sessionManager: { getSessionId: () => "advisor-root", getBranch: () => branch, getEntries: () => branch },
		isIdle: () => false, hasPendingMessages: () => false, ui: { notify(message: string) { notices.push(message); }, setStatus() {} },
		getSystemPrompt: () => "Base prompt",
	};
	await h.handlers.get("session_start")({}, context);
	const preflight = await h.handlers.get("before_agent_start")({ prompt: "Review the fixture" }, context);
	expect(h.roleModels).toEqual(["advisor"]);
	expect(preflight.message.details).toMatchObject({ [ADVISOR_PREFLIGHT_DETAIL]: true, status: "failed", model: "fixture/advisor" });
	expect(preflight.message.details.usage.cost.total).toBe(0.004);
	expect(notices).toEqual(["Advisor preflight failed; continuing with the Executor."]);
	branch.push({ type: "custom_message", customType: preflight.message.customType, details: preflight.message.details });
	expect(advisorCallCount(branch)).toBe(1);
	expect(advisorCost(branch)).toBeCloseTo(0.004);
	const output = await h.providers[0].streamSimple(h.providers[0].getModels()[0], { messages: [{ role: "user", content: "Review", timestamp: 1 }], tools: [] }, { sessionId: "advisor-root" }).result();
	expect(h.roleModels).toEqual(["advisor", "executor"]);
	expect(output.model).toBe("executor");
});
test("stale advisor preflight discards advice and does not start the Executor", async () => {
	const preset = defaultAdvisorPreset();
	preset.executor = { model: "fixture/executor", thinking: "medium" };
	preset.advisor = { model: "fixture/advisor", thinking: "high" };
	const h = await harness(JSON.stringify({ version: 3, presets: { advisor: preset } }));
	let started!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const usage = { ...emptyUsage(), input: 10, totalTokens: 10, cost: { ...emptyUsage().cost, input: 0.01, total: 0.01 } };
	const originalProvider = h.registry.getProvider;
	h.registry.getProvider = () => ({ streamSimple: (model: any, context: any, options: any) => {
		if (model.id !== "advisor") return originalProvider()!.streamSimple(model, context, options);
		h.roleModels.push(model.id);
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: { role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [], usage, stopReason: "pending", timestamp: 1 } } as any);
		started();
		return stream;
	} }) as any;
	const branch: any[] = [];
	const context = {
		cwd: h.dir, modelRegistry: h.registry, thinkingLevel: "max", model: { provider: "mixture", id: "advisor" }, hasUI: true,
		sessionManager: { getSessionId: () => "advisor-root", getBranch: () => branch, getEntries: () => branch },
		isIdle: () => false, hasPendingMessages: () => false, ui: { notify() {}, setStatus() {} },
		getSystemPrompt: () => "Base prompt",
	};
	await h.handlers.get("session_start")({}, context);
	const request = h.handlers.get("before_agent_start")({ prompt: "Start carefully" }, context);
	await ready;
	await new Promise(resolve => setTimeout(resolve, 0));
	await h.handlers.get("model_select")({}, { ...context, model: { provider: "fixture", id: "other" } });
	const canceled = await request;
	expect(canceled?.message.details).toMatchObject({ [ADVISOR_PREFLIGHT_DETAIL]: true, status: "aborted" });
	expect(h.roleModels).toEqual(["advisor"]);
	const output = await h.providers[0].streamSimple(h.providers[0].getModels()[0], { messages: [
		{ role: "user", content: "Start carefully", timestamp: 1 },
		{ role: "user", content: canceled.message.content, timestamp: 2 },
	], tools: [] }, { sessionId: "advisor-root" }).result();
	expect(output.stopReason).toBe("aborted");
	expect(h.roleModels).toEqual(["advisor"]);
	expect(h.appendedEntries).toHaveLength(1);
	expect(h.appendedEntries[0]).toMatchObject({ customType: ADVISOR_PREFLIGHT_USAGE_ENTRY, data: { [ADVISOR_PREFLIGHT_DETAIL]: true, status: "aborted", usage: { cost: { total: 0.01 } } } });
	branch.push({ type: "custom", customType: ADVISOR_PREFLIGHT_USAGE_ENTRY, data: h.appendedEntries[0].data });
	branch.push({ type: "custom_message", customType: canceled.message.customType, details: canceled.message.details });
	expect(advisorCallCount(branch)).toBe(1);
	expect(advisorCost(branch)).toBeCloseTo(0.01);
	await h.handlers.get("model_select")({}, context);
	const nextPreflight = await h.handlers.get("before_agent_start")({ prompt: "Start carefully" }, context);
	expect(nextPreflight.message.details).toMatchObject({ status: "skipped" });
	const next = await h.providers[0].streamSimple(h.providers[0].getModels()[0], { messages: [
		{ role: "user", content: canceled.message.content, timestamp: 3 },
		{ role: "user", content: "Start carefully", timestamp: 4 },
		{ role: "user", content: nextPreflight.message.content, timestamp: 5 },
	], tools: [] }, { sessionId: "advisor-root" }).result();
	expect(next.model).toBe("executor");
});
test("model changes after a completed preflight do not start the Executor", async () => {
	const preset = defaultAdvisorPreset();
	preset.executor = { model: "fixture/executor", thinking: "medium" };
	preset.advisor = { model: "fixture/advisor", thinking: "high" };
	const h = await harness(JSON.stringify({ version: 3, presets: { advisor: preset } }));
	const branch: any[] = [];
	const context = {
		cwd: h.dir, modelRegistry: h.registry, thinkingLevel: "max", model: { provider: "mixture", id: "advisor" }, hasUI: true,
		sessionManager: { getSessionId: () => "advisor-root", getBranch: () => branch, getEntries: () => branch },
		isIdle: () => false, hasPendingMessages: () => false, ui: { notify() {}, setStatus() {} },
		getSystemPrompt: () => "Base prompt",
	};
	await h.handlers.get("session_start")({}, context);
	const preflight = await h.handlers.get("before_agent_start")({ prompt: "Do not race the model switch" }, context);
	expect(h.roleModels).toEqual(["advisor"]);
	await h.handlers.get("model_select")({}, { ...context, model: { provider: "fixture", id: "other" } });
	await h.handlers.get("model_select")({}, context);
	const output = await h.providers[0].streamSimple(h.providers[0].getModels()[0], { messages: [
		{ role: "user", content: "Do not race the model switch", timestamp: 1 },
		{ role: "user", content: preflight.message.content, timestamp: 2 },
	], tools: [] }, { sessionId: "advisor-root" }).result();
	expect(output.stopReason).toBe("aborted");
	expect(h.roleModels).toEqual(["advisor"]);
});
test("session switches wait for a preflight and attribute discarded usage to the old session", async () => {
	const preset = defaultAdvisorPreset();
	preset.executor = { model: "fixture/executor", thinking: "medium" };
	preset.advisor = { model: "fixture/advisor", thinking: "high" };
	const h = await harness(JSON.stringify({ version: 3, presets: { advisor: preset } }));
	let started!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const originalProvider = h.registry.getProvider;
	h.registry.getProvider = () => ({ streamSimple: (model: any, providerContext: any, options: any) => {
		if (model.id !== "advisor") return originalProvider()!.streamSimple(model, providerContext, options);
		const stream = createAssistantMessageEventStream();
		started();
		return stream;
	} }) as any;
	let sessionId = "old-root";
	const branch: any[] = [];
	const sessionManager = { getSessionId: () => sessionId, getBranch: () => branch, getEntries: () => branch };
	const context = {
		cwd: h.dir, modelRegistry: h.registry, thinkingLevel: "max", model: { provider: "mixture", id: "advisor" }, hasUI: true,
		sessionManager, isIdle: () => false, hasPendingMessages: () => false, ui: { notify() {}, setStatus() {} },
		getSystemPrompt: () => "Base prompt",
	};
	await h.handlers.get("session_start")({}, context);
	const request = h.handlers.get("before_agent_start")({ prompt: "Switch safely" }, context);
	await ready;
	await h.handlers.get("session_before_switch")({ reason: "resume" }, context);
	sessionId = "new-root";
	const canceled = await request;
	expect(canceled?.message.details).toMatchObject({ [ADVISOR_PREFLIGHT_DETAIL]: true, status: "aborted" });
	expect(h.appendedEntries).toHaveLength(1);
	expect(h.appendedEntries[0].data).toMatchObject({ sessionId: "old-root", status: "aborted" });
	branch.push({ type: "custom", customType: ADVISOR_PREFLIGHT_USAGE_ENTRY, data: h.appendedEntries[0].data });
	await h.handlers.get("session_start")({}, context);
	const nextPreflight = await h.handlers.get("before_agent_start")({ prompt: "Switch safely" }, context);
	expect(nextPreflight.message.details).toMatchObject({ status: "skipped" });
	const next = await h.providers[0].streamSimple(h.providers[0].getModels()[0], { messages: [
		{ role: "user", content: canceled.message.content, timestamp: 3 },
		{ role: "user", content: "Switch safely", timestamp: 4 },
		{ role: "user", content: nextPreflight.message.content, timestamp: 5 },
	], tools: [] }, { sessionId: "new-root" }).result();
	expect(next.model).toBe("executor");
});
test("advisor mode is a selectable Mixture model whose executor owns tools and consults its configured advisor", async () => {
	const preset = defaultAdvisorPreset();
	preset.preflight = false;
	preset.executor = { model: "openai-codex/executor", thinking: "medium", fast: true };
	preset.advisor = { model: "openai-codex/advisor", thinking: "high" };
	const h = await harness(JSON.stringify({ version: 3, presets: { advisor: preset } }), false);
	const branch: any[] = [{ type: "message", message: { role: "user", content: "Check the fixture" } }];
	const context = {
		cwd: h.dir, modelRegistry: h.registry, thinkingLevel: "max", model: { provider: "mixture", id: "advisor" }, hasUI: true,
		sessionManager: { getSessionId: () => "advisor-root", getBranch: () => branch, getEntries: () => branch },
		isIdle: () => false, hasPendingMessages: () => false,
		getSystemPrompt: () => "Base prompt", ui: { notify() {}, setStatus(key: string, value: string | undefined) { h.statusUpdates.push({ key, value }); } },
	};
	await h.handlers.get("session_start")({}, context);
	expect(h.statusUpdates.at(-1)).toEqual({ key: "mixture", value: "executor · advisor 0 · $0.000" });
	expect(h.activeTools).toContain(ASK_ADVISOR);
	expect(h.activeTools).not.toContain("mixture_control");
	const provider = h.providers[0];
	const output = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "Execute", timestamp: 1 }], tools: [] }, { sessionId: "advisor-root" }).result();
	expect(output.model).toBe("executor");
	expect(h.roleOptions[0].reasoning).toBe("medium");
	expect(h.roleOptions[0].serviceTier).toBe("priority");
	const prompt = await h.handlers.get("before_agent_start")({ prompt: "Execute" }, context);
	expect(prompt.systemPrompt).toContain("Mixture advisor mode");
	expect(prompt.systemPrompt).toContain("must call ask_advisor at least once");
	expect(prompt.systemPrompt).toContain("every 5 minutes");
	expect(prompt.systemPrompt).toContain("after two materially equivalent failed attempts");
	const tool = h.definitions.get(ASK_ADVISOR);
	const call = { toolCallId: "advisor-call", toolName: ASK_ADVISOR, input: {} };
	expect(h.handlers.get("tool_call")(call, context)).toBeUndefined();
	const blockedCall = { toolCallId: "advisor-call-too-soon", toolName: ASK_ADVISOR, input: {} };
	const blocked = h.handlers.get("tool_call")(blockedCall, context);
	expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("throttled") });
	const blockedMessage = {
		role: "toolResult", toolCallId: blockedCall.toolCallId, toolName: ASK_ADVISOR,
		content: [{ type: "text", text: blocked.reason }], details: {}, isError: true, timestamp: Date.now(),
	};
	const marked = await h.handlers.get("message_end")({ message: blockedMessage });
	expect(marked.message.details).toMatchObject({ [ADVISOR_BLOCKED_DETAIL]: true });
	branch.push({ type: "message", message: marked.message });
	const advice = await tool.execute("advisor-call", {}, undefined, undefined, context);
	expect(advice.content[0].text).toBe("summary");
	expect(advice.details.model).toBe("openai-codex/advisor");
	const advisorUsage = { ...advice.usage, cost: { ...advice.usage.cost, total: 0.004 } };
	h.handlers.get("tool_result")({ toolCallId: "advisor-call", toolName: ASK_ADVISOR, usage: advisorUsage }, context);
	expect(h.statusUpdates.at(-1)).toEqual({ key: "mixture", value: "executor · advisor 1 · $0.004" });
	branch.push({ type: "message", message: { role: "toolResult", toolCallId: "advisor-call", toolName: ASK_ADVISOR, usage: advisorUsage, timestamp: Date.now() } });
	expect(h.roleOptions[1].reasoning).toBe("high");
	expect(h.roleOptions[1].serviceTier).toBe("default");
	expect(h.roleOptions[1].maxTokens).toBe(4_096);
	await h.handlers.get("agent_end")({ messages: [] });
	expect(h.statusUpdates.at(-1)).toEqual({ key: "mixture", value: "executor · advisor 1 · $0.004" });
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
