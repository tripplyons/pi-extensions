import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Provider } from "@earendil-works/pi-ai";
import swarmExtension from "../agent-swarm/index.ts";
import { isSwarmAttached, publishSwarmAttachment } from "../agent-swarm/events.ts";
import { makeNode } from "../agent-swarm/runtime.ts";
import { SCHEMA_VERSION } from "../agent-swarm/types.ts";
import { WorkerMailbox } from "../agent-swarm/worker.ts";
import { defaultConfig } from "./config.ts";
import { createMixtureExtension } from "./index.ts";
import { emitMessage, emptyUsage, type Registry } from "./provider.ts";

const originalAgent = process.env.PI_CODING_AGENT_DIR;
const originalSwarmHome = process.env.PI_SWARM_HOME;
const workerEnvironmentKeys = ["PI_SWARM_WORKER", "PI_SWARM_RUN", "PI_SWARM_NODE", "PI_SWARM_TOKEN"];
const originalWorkerEnvironment = workerEnvironmentKeys.map(key => process.env[key]);
const temporaryDirectories: string[] = [];

afterEach(() => {
	if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgent;
	if (originalSwarmHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = originalSwarmHome;
	for (const [index, key] of workerEnvironmentKeys.entries()) {
		if (originalWorkerEnvironment[index] === undefined) delete process.env[key]; else process.env[key] = originalWorkerEnvironment[index];
	}
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeMixtureConfig(agent: string) {
	const preset = structuredClone(defaultConfig().presets.default);
	preset.lead = "fixture/lead";
	preset.writer.model = "fixture/writer";
	preset.reviewers = [];
	writeFileSync(join(agent, "mixture.json"), JSON.stringify({ version: 3, presets: { default: preset } }));
}

function roleModel(provider: string, id: string): Model<any> {
	return { provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: emptyUsage().cost } as Model<any>;
}

let nextToolCall = 0;
function toolMessage(model: Model<any>, name: string, arguments_: Record<string, unknown>): AssistantMessage {
	nextToolCall++;
	return { role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: 1, stopReason: "toolUse", content: [{ type: "toolCall", id: `combined-call-${nextToolCall}`, name, arguments: arguments_ }], usage: emptyUsage() };
}

interface CombinedHarness {
	pi: any;
	bus: EventEmitter;
	handlers: Map<string, Function[]>;
	commands: Map<string, any>;
	tools: Map<string, any>;
	providers: Provider[];
	registry: Registry;
	roleContexts: Context[];
}

async function combinedHarness(responses: { lead: AssistantMessage[]; writer: AssistantMessage[] }): Promise<CombinedHarness> {
	const bus = new EventEmitter();
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const providers: Provider[] = [];
	const activeTools = new Set(["read", "bash", "edit", "write"]);
	const roleContexts: Context[] = [];
	const registry: Registry = {
		find: (provider, id) => roleModel(provider, id),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({
			streamSimple(model, context) {
				roleContexts.push(context);
				const queue = model.id === "lead" ? responses.lead : responses.writer;
				const message = queue.shift();
				if (!message) throw new Error(`No deterministic response for ${model.id}`);
				const stream = createAssistantMessageEventStream();
				emitMessage(stream, message);
				return stream;
			},
		}) as any,
	};
	const pi: any = {
		events: {
			emit(name: string, value: unknown) { return bus.emit(name, value); },
			on(name: string, listener: (...args: any[]) => void) { bus.on(name, listener); return () => bus.off(name, listener); },
		},
		registerTool(tool: any) { tools.set(tool.name, tool); activeTools.add(tool.name); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: Function) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => handlers.set(name, list.filter(item => item !== handler)); },
		getActiveTools: () => [...activeTools],
		getAllTools: () => [...tools.values()],
		setActiveTools(names: string[]) { activeTools.clear(); for (const name of names) activeTools.add(name); },
		getThinkingLevel: () => "low",
		registerProvider(provider: Provider) { providers.push(provider); },
		unregisterProvider(id: string) { const index = providers.findIndex(provider => provider.id === id); if (index >= 0) providers.splice(index, 1); },
		appendEntry() {},
		sendMessage() {},
		sendUserMessage() {},
	};
	await swarmExtension(pi);
	await createMixtureExtension(pi, registry);
	return { pi, bus, handlers, commands, tools, providers, registry, roleContexts };
}

async function dispatch(harness: CombinedHarness, name: string, event: any, context: any) {
	let current = event;
	for (const handler of harness.handlers.get(name) ?? []) {
		const result = await handler(current, context);
		if (result && typeof result === "object") current = { ...current, ...result };
	}
	return current;
}

async function mixtureTurn(harness: CombinedHarness, context: any, prompt: string, start = false, systemPrompt = "Combined fixture system prompt") {
	const before = start ? await dispatch(harness, "before_agent_start", { prompt, systemPrompt }, context) : { systemPrompt };
	const model = harness.providers.find(provider => provider.id === "mixture")!.getModels()[0];
	const request: Context = { systemPrompt: before.systemPrompt, messages: [{ role: "user", content: prompt, timestamp: 1 }], tools: harness.pi.getAllTools() };
	const message = await harness.providers.find(provider => provider.id === "mixture")!.streamSimple(model, request, { sessionId: context.sessionManager.getSessionId() }).result();
	const call = message.content.find(block => block.type === "toolCall");
	if (!call) return { before, message };
	const toolCall = await dispatch(harness, "tool_call", { toolCallId: call.id, toolName: call.name, input: call.arguments }, context);
	if (toolCall.block) return { before, message, blocked: toolCall };
	const tool = harness.tools.get(call.name);
	if (!tool) throw new Error(`Missing combined tool ${call.name}`);
	const output = await tool.execute(call.id, call.arguments, new AbortController().signal, undefined, context);
	const toolResult = await dispatch(harness, "tool_result", {
		role: "toolResult", toolCallId: call.id, toolName: call.name, ...output, isError: false, timestamp: Date.now(),
	}, context);
	await dispatch(harness, "turn_end", { message, toolResults: [toolResult] }, context);
	return { before, message, call, output: toolResult };
}

function context(cwd: string, sessionId: string, registry: Registry) {
	return {
		cwd, model: { provider: "mixture", id: "default" }, modelRegistry: registry, thinkingLevel: "low", hasUI: false,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] },
		ui: { notify() {}, setStatus() {} }, isIdle: () => true, hasPendingMessages: () => false,
	};
}

test("mocked coordinator attachment keeps Mixture control and lead Swarm reads on one event bus", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-mixture-coordinator-"));
	const agent = mkdtempSync(join(tmpdir(), "pi-mixture-coordinator-agent-"));
	const state = mkdtempSync(join(tmpdir(), "pi-mixture-coordinator-state-"));
	temporaryDirectories.push(root, agent, state);
	process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_SWARM_HOME = state;
	writeMixtureConfig(agent);
	const leadResponses = [
		toolMessage(roleModel("fixture", "lead"), "mixture_control", { action: "delegate", task: "Coordinate the attached check", nextAction: "Read the swarm task", successCriteria: ["The task is read"] }),
		toolMessage(roleModel("fixture", "lead"), "swarm_task", {}),
	];
	const writerResponses = [toolMessage(roleModel("fixture", "writer"), "mixture_control", { action: "report", report: "The attached check is ready for lead review" })];
	const harness = await combinedHarness({ lead: leadResponses, writer: writerResponses });
	const ctx = context(root, "coordinator-combined", harness.registry);
	let attachment: ReturnType<typeof publishSwarmAttachment> | undefined;
	try {
		await dispatch(harness, "session_start", {}, ctx);
		expect(isSwarmAttached(harness.pi)).toBe(false);
		attachment = publishSwarmAttachment(harness.pi, true);
		harness.pi.setActiveTools([...harness.pi.getActiveTools(), "swarm_task", "swarm_integrate"]);
		harness.tools.set("swarm_task", { name: "swarm_task", execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ runId: "run_mock", role: "coordinator" }) }] }) });
		const starts = harness.handlers.get("before_agent_start") ?? [];
		starts.push((event: any) => ({ systemPrompt: `${event.systemPrompt}\nSwarm role: coordinator` }));
		harness.handlers.set("before_agent_start", starts);
		expect(isSwarmAttached(harness.pi)).toBe(true);
		expect(harness.pi.getActiveTools()).toEqual(expect.arrayContaining(["mixture_control", "swarm_task", "swarm_integrate"]));
		const first = await mixtureTurn(harness, ctx, "Coordinate the attached check", true);
		expect(first.before.systemPrompt).toContain("Swarm role: coordinator");
		const systemPrompt = first.before.systemPrompt;
		expect(first.call).toMatchObject({ name: "mixture_control", arguments: { action: "delegate" } });
		const second = await mixtureTurn(harness, ctx, "Coordinate the attached check", false, systemPrompt);
		expect(second.call).toMatchObject({ name: "mixture_control", arguments: { action: "report" } });
		const third = await mixtureTurn(harness, ctx, "Coordinate the attached check", false, systemPrompt);
		expect(third.call?.name).toBe("swarm_task");
		expect(String(third.output.content[0].text)).toContain("runId");
		expect(harness.roleContexts.find(call => call.tools?.some(tool => tool.name === "swarm_task"))).toBeDefined();
		attachment.dispose();
		expect(isSwarmAttached(harness.pi)).toBe(false);
	} finally {
		attachment?.dispose();
		await dispatch(harness, "session_shutdown", {}, ctx);
	}
});

test("mocked worker mailbox attachment lets a Mixture lead submit through swarm_complete while its writer is denied", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-mixture-worker-"));
	const agent = mkdtempSync(join(tmpdir(), "pi-mixture-worker-agent-"));
	const state = mkdtempSync(join(tmpdir(), "pi-mixture-worker-state-"));
	temporaryDirectories.push(root, agent, state);
	process.env.PI_CODING_AGENT_DIR = agent; process.env.PI_SWARM_HOME = state;
	Object.assign(process.env, { PI_SWARM_WORKER: "1", PI_SWARM_RUN: "run_combined", PI_SWARM_NODE: "node_worker", PI_SWARM_TOKEN: "worker-token" });
	writeMixtureConfig(agent);
	const rootNode = makeNode("run_combined", "node_root", "coordinator", "Root", root, null);
	const workerNode = makeNode("run_combined", "node_worker", "worker", "Worker task", root, rootNode.nodeId);
	const snapshot = { schemaVersion: SCHEMA_VERSION, status: "active" as const, maxInlineBytes: 65_536, node: workerNode, nodes: [rootNode, workerNode], messages: [] };
	const requests: Array<[string, Record<string, unknown>]> = [];
	const request = spyOn(WorkerMailbox.prototype, "request").mockImplementation(async (kind: any, payload: any) => { requests.push([kind, payload]); return {}; });
	const readSnapshot = spyOn(WorkerMailbox.prototype, "snapshot").mockReturnValue(snapshot as any);
	const leadResponses = [
		toolMessage(roleModel("fixture", "lead"), "mixture_control", { action: "delegate", task: "Complete the worker task", nextAction: "Run the worker check", successCriteria: ["The worker check passes"] }),
		toolMessage(roleModel("fixture", "lead"), "mixture_control", { action: "takeover" }),
		toolMessage(roleModel("fixture", "lead"), "swarm_complete", { text: "Worker result", verification: "Deterministic mailbox fixture" }),
	];
	const writerResponses = [
		toolMessage(roleModel("fixture", "writer"), "swarm_complete", { text: "Writer must not submit" }),
		toolMessage(roleModel("fixture", "writer"), "mixture_control", { action: "report", report: "The worker task is complete" }),
	];
	const harness = await combinedHarness({ lead: leadResponses, writer: writerResponses });
	const ctx = context(root, "worker-combined", harness.registry);
	try {
		await dispatch(harness, "session_start", {}, ctx);
		expect(requests[0]).toEqual(["ready", { sessionId: "worker-combined" }]);
		expect(isSwarmAttached(harness.pi)).toBe(true);
		expect(harness.pi.getActiveTools()).toEqual(expect.arrayContaining(["swarm_complete", "mixture_control"]));
		const first = await mixtureTurn(harness, ctx, "Complete the worker task", true);
		expect(first.before.systemPrompt).toContain("Swarm role: worker");
		const systemPrompt = first.before.systemPrompt;
		expect(first.call?.name).toBe("mixture_control");
		const denied = await mixtureTurn(harness, ctx, "Complete the worker task", false, systemPrompt);
		expect(denied.message.stopReason).toBe("error");
		expect(denied.message.errorMessage).toContain("cannot call swarm_complete");
		expect(harness.roleContexts.at(-1)?.tools?.some(tool => tool.name === "swarm_complete")).toBe(false);
		const report = await mixtureTurn(harness, ctx, "Complete the worker task", false, systemPrompt);
		expect(report.call).toMatchObject({ name: "mixture_control", arguments: { action: "report" } });
		const takeover = await mixtureTurn(harness, ctx, "Complete the worker task", false, systemPrompt);
		expect(takeover.call).toMatchObject({ name: "mixture_control", arguments: { action: "takeover" } });
		const complete = await mixtureTurn(harness, ctx, "Complete the worker task", false, systemPrompt);
		expect(complete.call?.name).toBe("swarm_complete");
		expect(requests.at(-1)).toEqual(["complete", { text: "Worker result", verification: "Deterministic mailbox fixture" }]);
	} finally {
		await dispatch(harness, "session_shutdown", {}, ctx);
		request.mockRestore();
		readSnapshot.mockRestore();
	}
});
