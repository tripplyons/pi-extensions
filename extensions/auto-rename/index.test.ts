import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import autoRename from "./index.ts";
import { createMixtureExtension } from "../mixture/index.ts";
import { defaultConfig } from "../mixture/config.ts";
import { emptyUsage, type Registry } from "../mixture/provider.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function model(provider = "fixture", id = "model"): Model<any> {
	return {
		provider, id, name: id, api: "fixture", baseUrl: "https://original.invalid",
		reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 2_000,
		cost: emptyUsage().cost,
	};
}

function response(model: Model<any>, text?: string, stopReason: "stop" | "error" | "aborted" = "stop", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: 1,
		stopReason, content: text === undefined ? [] : [{ type: "text", text }], usage: emptyUsage(),
		...(errorMessage === undefined ? {} : { errorMessage }),
	};
}

function terminalStream(message: AssistantMessage, terminal: "done" | "error" = "done"): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } as AssistantMessage });
	if (terminal === "done") {
		stream.push({ type: "done", reason: message.stopReason as "stop", message });
	} else {
		stream.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
	}
	stream.end();
	return stream;
}

function incompleteStream(model: Model<any>): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message = response(model);
	stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } as AssistantMessage });
	stream.end();
	return stream;
}

type StreamCall = { model: Model<any>; context: Context; options?: SimpleStreamOptions };
type AuthResult =
	| { ok: true; apiKey?: string; headers?: Record<string, string | null>; env?: Record<string, string>; baseUrl?: string }
	| { ok: false; error: string };
type StreamFactory = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

function providerFor(model: Model<any>, streamSimple: StreamFactory): Provider {
	return {
		id: model.provider,
		name: "Fixture",
		auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
		getModels: () => [model],
		stream: () => { throw new Error("The test provider only supports simple requests"); },
		streamSimple: streamSimple as Provider["streamSimple"],
	};
}

interface RenameHarness {
	ctx: any;
	authCalls: Model<any>[];
	notices: string[];
	statuses: Array<{ key: string; value: string | undefined }>;
	runAgentEnd(): Promise<void>;
	getName(): string | undefined;
}

function renameHarness(options: {
	model?: Model<any>;
	provider?: Provider;
	streamSimple?: StreamFactory;
	auth?: AuthResult;
	authResolver?: (model: Model<any>) => Promise<AuthResult>;
	getProvider?: (provider: string) => Provider | undefined;
	initialName?: string;
	entries?: any[];
} = {}): RenameHarness {
	const selectedModel = options.model ?? model();
	const authCalls: Model<any>[] = [];
	const notices: string[] = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	let sessionName = options.initialName;
	const handlers = new Map<string, Function[]>();
	const provider = options.provider ?? providerFor(selectedModel, options.streamSimple ?? ((requestModel) => terminalStream(response(requestModel, "Repair parser"))));
	const registry = {
		getProvider: options.getProvider ?? ((providerId: string) => providerId === selectedModel.provider ? provider : undefined),
		getApiKeyAndHeaders: async (requestModel: Model<any>) => {
			authCalls.push(requestModel);
			if (options.authResolver) return options.authResolver(requestModel);
			return options.auth ?? { ok: true, apiKey: "secret", headers: { "x-fixture": "yes" }, env: { REGION: "test" }, baseUrl: "https://resolved.invalid" };
		},
	};
	const pi = {
		on(event: string, handler: Function) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => handlers.set(event, list.filter(item => item !== handler));
		},
		getSessionName: () => sessionName,
		setSessionName: (name: string) => { sessionName = name; },
	};
	const ctx = {
		model: selectedModel,
		modelRegistry: registry,
		sessionManager: { getBranch: () => options.entries ?? [] },
		ui: {
			setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
			notify: (message: string) => notices.push(message),
		},
	};
	autoRename(pi as any);
	return {
		ctx,
		authCalls,
		notices,
		statuses,
		runAgentEnd: async () => {
			for (const handler of handlers.get("agent_end") ?? []) await handler({}, ctx);
		},
		getName: () => sessionName,
	};
}

test("uses the registered provider with resolved auth and preserves the naming request", async () => {
	const selectedModel = model("custom", "custom-name");
	const entries = [
		{ type: "message", message: { role: "user", content: "Fix the parser", timestamp: 1 } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "Do not include this" }], timestamp: 2 } },
		{ type: "custom", customType: "unrelated", data: { text: "Do not include this either" } },
		{ type: "message", message: { role: "assistant", content: [
			{ type: "text", text: "The parser is fixed" },
			{ type: "toolCall", id: "read", name: "read", arguments: { path: "parser.ts" } },
		], timestamp: 3 } },
	];
	const calls: StreamCall[] = [];
	const harness = renameHarness({
		model: selectedModel,
		entries,
		streamSimple: (requestModel, context, options) => {
			calls.push({ model: requestModel, context, options });
			return terminalStream(response(requestModel, "  Repair   parser  \nIgnore this line"));
		},
	});

	await harness.runAgentEnd();

	expect(harness.getName()).toBe("Repair parser");
	expect(calls).toHaveLength(1);
	expect(calls[0].model).toMatchObject({ provider: "custom", id: "custom-name", baseUrl: "https://resolved.invalid" });
	expect(calls[0].options).toEqual({
		apiKey: "secret",
		headers: { "x-fixture": "yes" },
		env: { REGION: "test" },
		maxTokens: 64,
	});
	expect(calls[0].context.systemPrompt).toContain("Name coding-agent sessions.");
	const prompt = calls[0].context.messages[0].content;
	expect(prompt).toEqual([{ type: "text", text: expect.stringContaining("User: Fix the parser\n\nAssistant: The parser is fixed") }]);
	expect(String(prompt[0].text)).not.toContain("Do not include this");
	expect(String(prompt[0].text)).not.toContain("read parser.ts");
	expect(harness.authCalls).toEqual([selectedModel]);
	expect(harness.notices).toEqual([]);
	expect(harness.statuses).toEqual([
		{ key: "auto-rename", value: "naming…" },
		{ key: "auto-rename", value: undefined },
	]);
});

test("reports an unavailable provider and clears status", async () => {
	const harness = renameHarness({ getProvider: () => undefined });

	await harness.runAgentEnd();

	expect(harness.getName()).toBeUndefined();
	expect(harness.notices.at(-1)).toBe("Auto-rename failed: No provider registered for \"fixture\"");
	expect(harness.statuses.at(-1)).toEqual({ key: "auto-rename", value: undefined });
	expect(harness.authCalls).toHaveLength(0);
});

test("reports an authentication failure and clears status", async () => {
	const harness = renameHarness({ auth: { ok: false, error: "No fixture credential" } });

	await harness.runAgentEnd();

	expect(harness.getName()).toBeUndefined();
	expect(harness.notices.at(-1)).toBe("Auto-rename failed: No fixture credential");
	expect(harness.statuses.at(-1)).toEqual({ key: "auto-rename", value: undefined });
});

for (const [stopReason, errorMessage, notice] of [
	["error", "Provider rejected the naming request", "Auto-rename failed: Provider rejected the naming request"],
	["aborted", "ignored", "Auto-rename failed: Naming request was aborted"],
] as const) {
	test(`reports a ${stopReason} terminal event and clears status`, async () => {
		const harness = renameHarness({
			streamSimple: requestModel => terminalStream(response(requestModel, undefined, stopReason, errorMessage), "error"),
		});

		await harness.runAgentEnd();

		expect(harness.getName()).toBeUndefined();
		expect(harness.notices.at(-1)).toBe(notice);
		expect(harness.statuses.at(-1)).toEqual({ key: "auto-rename", value: undefined });
	});
}

test("reports a provider stream that ends without a terminal result", async () => {
	const harness = renameHarness({ streamSimple: requestModel => incompleteStream(requestModel) });

	await harness.runAgentEnd();

	expect(harness.getName()).toBeUndefined();
	expect(harness.notices.at(-1)).toBe("Auto-rename failed: Naming request ended without a terminal result");
	expect(harness.statuses.at(-1)).toEqual({ key: "auto-rename", value: undefined });
});

test("reports an empty successful response and clears status", async () => {
	const harness = renameHarness({ streamSimple: requestModel => terminalStream(response(requestModel)) });

	await harness.runAgentEnd();

	expect(harness.getName()).toBeUndefined();
	expect(harness.notices.at(-1)).toBe("Auto-rename failed: Naming request returned an empty name");
	expect(harness.statuses.at(-1)).toEqual({ key: "auto-rename", value: undefined });
});

test("skips naming a session that already has a name", async () => {
	const harness = renameHarness({ initialName: "Existing session" });

	await harness.runAgentEnd();

	expect(harness.getName()).toBe("Existing session");
	expect(harness.authCalls).toHaveLength(0);
	expect(harness.statuses).toEqual([]);
});

test("does not start a second naming request while the first is in flight", async () => {
	let resolveAuth!: (result: AuthResult) => void;
	const authGate = new Promise<AuthResult>(resolve => { resolveAuth = resolve; });
	const harness = renameHarness({
		authResolver: async () => authGate,
	});

	const first = harness.runAgentEnd();
	await Promise.resolve();
	await harness.runAgentEnd();
	expect(harness.authCalls).toHaveLength(1);
	expect(harness.statuses).toEqual([{ key: "auto-rename", value: "naming…" }]);

	resolveAuth({ ok: true, apiKey: "secret" });
	await first;
	expect(harness.getName()).toBe("Repair parser");
	expect(harness.statuses.at(-1)).toEqual({ key: "auto-rename", value: undefined });
});

function roleModel(provider: string, id: string): Model<any> {
	return {
		provider, id, name: id, api: "fixture", baseUrl: "https://role-original.invalid",
		reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 4_000,
		cost: emptyUsage().cost,
	};
}

interface MixtureRenameHarness {
	ctx: any;
	rootId: string;
	agentEndHandlers: Function[];
	getName(): string | undefined;
	branch: any[];
	appended: any[];
	activeTools: () => string[];
	authRequests: Model<any>[];
	roleCalls: StreamCall[];
	releasedIds: string[];
	notices: string[];
	dispatch(event: string, selectedHandlers?: Function[]): Promise<void>;
}

async function mixtureRenameHarness(): Promise<MixtureRenameHarness> {
	const agentDir = mkdtempSync(join(tmpdir(), "auto-rename-mixture-"));
	temporaryDirectories.push(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const config = defaultConfig();
	const preset = config.presets.default;
	preset.lead = "fixture/lead";
	preset.writer.model = "fixture/writer";
	preset.reviewers = [];
	writeFileSync(join(agentDir, "mixture.json"), JSON.stringify(config));

	const rootId = "mixture-root";
	const branch = [
		{ type: "message", message: { role: "user", content: "Name this repair session", timestamp: 1 } },
	];
	const appended: any[] = [];
	const authRequests: Model<any>[] = [];
	const roleCalls: StreamCall[] = [];
	const releasedIds: string[] = [];
	const notices: string[] = [];
	const handlers = new Map<string, Function[]>();
	let active = ["read", "write"];
	let sessionName: string | undefined;
	let mixtureProvider: Provider | undefined;
	const lead = roleModel("fixture", "lead");
	const writer = roleModel("fixture", "writer");
	const roleProvider: Provider = {
		id: "fixture",
		name: "Fixture",
		auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "role-secret" } }) } },
		getModels: () => [lead, writer],
		stream: () => { throw new Error("The role fixture only supports simple requests"); },
		streamSimple: (requestModel, context, options) => {
			roleCalls.push({ model: requestModel, context, options });
			return terminalStream(response(requestModel, "Mixture repair session"));
		},
	};
	const registry: Registry = {
		find: (provider, id) => {
			if (provider === "fixture") return [lead, writer].find(candidate => candidate.id === id);
			return mixtureProvider?.getModels().find(candidate => candidate.id === id);
		},
		getProvider: provider => provider === "fixture" ? roleProvider : provider === "mixture" ? mixtureProvider : undefined,
		getApiKeyAndHeaders: async requestModel => {
			authRequests.push(requestModel);
			if (requestModel.provider === "fixture") {
				return { ok: true, apiKey: "role-secret", headers: { "x-role": "yes" }, env: { REGION: "role" }, baseUrl: "https://role-resolved.invalid" };
			}
			return { ok: true, apiKey: "mixture-ambient" };
		},
	};
	const pi: any = {
		events: {
			on: () => () => {},
			emit: (name: string, value: any) => {
				if (name === "tripp:mixture-session-release/v1") releasedIds.push(...value.sessionIds);
			},
		},
		on: (event: string, handler: Function) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => handlers.set(event, list.filter(item => item !== handler));
		},
		registerProvider: (provider: Provider) => { if (provider.id === "mixture") mixtureProvider = provider; },
		unregisterProvider: (providerId: string) => { if (providerId === "mixture") mixtureProvider = undefined; },
		registerCommand: () => {},
		registerTool: () => {},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => { active = [...names]; },
		appendEntry: (customType: string, data: unknown) => appended.push({ type: "custom", customType, data }),
		getSessionName: () => sessionName,
		setSessionName: (name: string) => { sessionName = name; },
	};
	await createMixtureExtension(pi, registry);
	if (!mixtureProvider) throw new Error("Mixture provider was not registered");
	autoRename(pi);
	const ctx = {
		cwd: agentDir,
		model: mixtureProvider.getModels()[0],
		modelRegistry: registry,
		thinkingLevel: "low",
		hasUI: false,
		sessionManager: { getSessionId: () => rootId, getBranch: () => branch, getEntries: () => branch },
		ui: { notify: (message: string) => notices.push(message), setStatus() {} },
	};
	const dispatch = async (event: string, selectedHandlers = handlers.get(event) ?? []) => {
		for (const handler of selectedHandlers) await handler({}, ctx);
	};
	await dispatch("session_start");
	return {
		ctx, rootId, agentEndHandlers: handlers.get("agent_end") ?? [], getName: () => sessionName, branch, appended, activeTools: () => [...active], authRequests, roleCalls, releasedIds, notices,
		dispatch,
	};
}

test("routes selected Mixture naming through the configured lead helper", async () => {
	const harness = await mixtureRenameHarness();
	expect(harness.agentEndHandlers).toHaveLength(2);

	// Let Mixture finish its own agent_end work before observing the naming hook.
	await harness.dispatch("agent_end", [harness.agentEndHandlers[0]]);
	const selectedModel = harness.ctx.model;
	const beforeBranch = structuredClone(harness.branch);
	const beforeCheckpoints = structuredClone(harness.appended);
	const beforeTools = harness.activeTools();

	await harness.dispatch("agent_end", [harness.agentEndHandlers[1]]);

	expect(harness.getName()).toBe("Mixture repair session");
	expect(harness.ctx.model).toBe(selectedModel);
	expect(harness.ctx.model.provider).toBe("mixture");
	expect(harness.ctx.modelRegistry.getProvider("mixture")).toMatchObject({ id: "mixture" });
	expect(harness.roleCalls).toHaveLength(1);
	expect(harness.roleCalls[0].model).toMatchObject({ provider: "fixture", id: "lead", baseUrl: "https://role-resolved.invalid" });
	expect(harness.roleCalls[0].options).toMatchObject({
		apiKey: "role-secret", headers: { "x-role": "yes" }, env: { REGION: "role" }, maxTokens: 64,
	});
	expect(harness.roleCalls[0].options?.sessionId).toMatch(/^mixture-lane\//);
	expect(harness.roleCalls[0].options?.sessionId).not.toBe(harness.rootId);
	expect(harness.roleCalls[0].context.tools).toEqual([]);
	expect(harness.authRequests.map(request => `${request.provider}/${request.id}`)).toEqual(["mixture/default", "fixture/lead"]);
	expect(harness.releasedIds).toEqual([harness.roleCalls[0].options?.sessionId]);
	expect(harness.appended).toEqual(beforeCheckpoints);
	expect(harness.branch).toEqual(beforeBranch);
	expect(harness.activeTools()).toEqual(beforeTools);
	expect(harness.notices).toEqual([]);
});
