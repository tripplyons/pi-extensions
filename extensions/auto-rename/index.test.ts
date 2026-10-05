import { expect, test } from "bun:test";
import { normalizeContext, getCurrentSystemPrompt, createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import autoRename from "./index.ts";
function emptyUsage() {
 return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function model(provider = "openai", id = "gpt-6-luna"): Model<any> {
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
	namingModel?: Model<any>;
	available?: boolean;
	configuredAuth?: boolean;
	provider?: Provider;
	streamSimple?: StreamFactory;
	auth?: AuthResult;
	authResolver?: (model: Model<any>) => Promise<AuthResult>;
	getProvider?: (provider: string) => Provider | undefined;
	initialName?: string;
	entries?: any[];
} = {}): RenameHarness {
	const selectedModel = options.model ?? model("anthropic", "claude-opus-5-5");
	const namingModel = options.namingModel ?? model();
	const authCalls: Model<any>[] = [];
	const notices: string[] = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	let sessionName = options.initialName;
	const handlers = new Map<string, Function[]>();
	const provider = options.provider ?? providerFor(namingModel, options.streamSimple ?? ((requestModel) => terminalStream(response(requestModel, "Repair parser"))));
	const registry = {
		find: (providerId: string, id: string) => options.available !== false && providerId === namingModel.provider && id === namingModel.id ? namingModel : undefined,
		hasConfiguredAuth: () => options.configuredAuth !== false,
		getProvider: options.getProvider ?? ((providerId: string) => providerId === namingModel.provider ? provider : undefined),
		getApiKeyAndHeaders: async (requestModel: Model<any>) => {
			authCalls.push(requestModel);
			if (options.authResolver) return options.authResolver(requestModel);
			return options.auth ?? { ok: true, apiKey: "secret", headers: { "x-fixture": "yes" }, env: { REGION: "test" }, baseUrl: "https://resolved.invalid" };
		},
	};
	Object.assign(registry, {
		streamSimple: (requestModel: Model<any>, context: Context, requestOptions: SimpleStreamOptions) => ({
			async *[Symbol.asyncIterator]() {
				const auth = await registry.getApiKeyAndHeaders(requestModel);
				if (!auth.ok) throw new Error((auth as { error: string }).error);
				yield* provider.streamSimple(auth.baseUrl ? { ...requestModel, baseUrl: auth.baseUrl } : requestModel,
					normalizeContext(context), { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, ...requestOptions });
			},
		}),
	});
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

test("uses Luna with low reasoning and fast mode regardless of the selected model", async () => {
	const selectedModel = model("custom", "custom-name");
	const entries = [
		{ type: "message", message: { role: "user", content: "Fix the parser", timestamp: 1 } },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "Do not include this" }], timestamp: 2 } },
		{ type: "custom", customType: "unrelated", data: { text: "Do not include this either" } },
		{ type: "message", message: { role: "assistant", content: [
			{ type: "text", text: "The parser is fixed" },
			{ type: "toolCall", id: "read", name: "read", arguments: { path: "parser.ts" } },
		], timestamp: 3 } },
		{ type: "message", message: { role: "user", content: "Now change the database", timestamp: 4 } },
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
	expect(calls[0].model).toMatchObject({ provider: "openai", id: "gpt-6-luna", baseUrl: "https://resolved.invalid" });
	expect(calls[0].options).toEqual({
		apiKey: "secret",
		headers: { "x-fixture": "yes" },
		env: { REGION: "test" },
		maxTokens: 64,
		reasoning: "low",
		cacheRetention: "none",
		onPayload: expect.any(Function),
	});
	expect(await calls[0].options!.onPayload!({ model: "gpt-6-luna" }, calls[0].model)).toEqual({ model: "gpt-6-luna", service_tier: "priority" });
	expect(getCurrentSystemPrompt(calls[0].context.messages)).toContain("Name coding-agent sessions.");
	const prompt = calls[0].context.messages.find(message => message.role === "user")!.content;
	expect(prompt).toEqual([{ type: "text", text: "Name this session from the first user message below. Do not answer the task.\n\nFix the parser" }]);
	expect(String(prompt[0].text)).not.toContain("Do not include this");
	expect(String(prompt[0].text)).not.toContain("read parser.ts");
	expect(harness.authCalls).toEqual([expect.objectContaining({ provider: "openai", id: "gpt-6-luna" })]);
	expect(harness.ctx.model).toBe(selectedModel);
	expect(harness.notices).toEqual([]);
	expect(harness.statuses).toEqual([
		{ key: "auto-rename", value: "naming…" },
		{ key: "auto-rename", value: undefined },
	]);
});

for (const [label, content, expected] of [
	["text blocks", [{ type: "text", text: " Fix the parser" }, { type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "Add a test " }], "Fix the parser\nAdd a test"],
	["long message", "x".repeat(60_001), "x".repeat(60_000)],
	["empty first message", "   ", ""],
] as const) {
	test(`uses only the first user message: ${label}`, async () => {
		const calls: StreamCall[] = [];
		const harness = renameHarness({
			entries: [
				{ type: "message", message: { role: "assistant", content: "Earlier assistant reply" } },
				{ type: "custom", customType: "unrelated", data: {} },
				{ type: "message", message: { role: "user", content } },
				{ type: "message", message: { role: "user", content: "Do not use this later message" } },
			],
			streamSimple: (requestModel, context, options) => {
				calls.push({ model: requestModel, context, options });
				return terminalStream(response(requestModel, "Repair parser"));
			},
		});

		await harness.runAgentEnd();

		expect(calls).toHaveLength(1);
		const prompt = calls[0].context.messages.find(message => message.role === "user")!.content;
		expect(prompt).toEqual([{ type: "text", text: `Name this session from the first user message below. Do not answer the task.\n\n${expected}` }]);
	});
}

test("uses the Codex Luna fallback through the tool-free standalone path", async () => {
	const selectedModel = model("claude-bridge", "claude-opus-5-5");
	const harness = renameHarness({
		model: selectedModel,
		namingModel: model("openai-codex"),
		entries: [{ type: "message", message: { role: "user", content: "Build Brawl with Bazel", timestamp: 1 } }],
		streamSimple: (requestModel, context, options) => {
			expect(requestModel.provider).toBe("openai-codex");
			expect(requestModel.id).toBe("gpt-6-luna");
			expect(options!.onPayload!({}, requestModel)).toEqual({ service_tier: "priority" });
			const messages = context.messages.filter(message => message.role !== "system");
			if (options?.cacheRetention !== "none" || context.tools !== undefined ||
				messages.length !== 1 || messages[0].role !== "user") {
				return terminalStream(response(requestModel, undefined, "error", "Naming request entered the live agent session"), "error");
			}
			return terminalStream(response(requestModel, "Build Brawl with Bazel"));
		},
	});

	await harness.runAgentEnd();

	expect(harness.getName()).toBe("Build Brawl with Bazel");
	expect(harness.notices).toEqual([]);
});

for (const options of [{ available: false }, { configuredAuth: false }]) {
	test(`reports unavailable Luna or authentication: ${JSON.stringify(options)}`, async () => {
		const harness = renameHarness(options);
		await harness.runAgentEnd();
		expect(harness.getName()).toBeUndefined();
		expect(harness.notices.at(-1)).toBe("Auto-rename failed: Title generation requires gpt-6-luna with OpenAI authentication. Use /login and check /model.");
		expect(harness.authCalls).toHaveLength(0);
		expect(harness.statuses.at(-1)).toEqual({ key: "auto-rename", value: undefined });
	});
}

test("reports an unavailable provider and clears status", async () => {
	const harness = renameHarness({ getProvider: () => undefined });

	await harness.runAgentEnd();

	expect(harness.getName()).toBeUndefined();
	expect(harness.notices.at(-1)).toBe("Auto-rename failed: No provider registered for \"openai\"");
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
