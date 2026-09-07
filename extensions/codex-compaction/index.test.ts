import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "./native-compaction.ts";

const piExecutable = Bun.which("pi");
if (!piExecutable) throw new Error("pi is required to test Codex compaction");
const piCli = realpathSync(piExecutable);
// Import the session/message cores directly: the package root pulls in
// dist/experimental/server.js, which requires the unpublished
// @earendil-works/pi-server module. native-compaction.ts only needs these
// three runtime values from pi-coding-agent.
const piCoreDir = resolve(dirname(piCli), "../core");
const sessionManager = await import(resolve(piCoreDir, "session-manager.js"));
const messages = await import(resolve(piCoreDir, "messages.js"));
mock.module("@earendil-works/pi-coding-agent", () => ({
	...sessionManager,
	...messages,
}));
mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[], options: object) => ({ type: "string", enum: [...values], ...options }),
	calculateCost: (_model: unknown, usage: any) => usage.cost,
}));
mock.module("typebox", () => ({
	Type: {
		Integer: (options: object) => ({ type: "integer", ...options }),
		Object: (properties: object) => ({ type: "object", properties }),
		Optional: (schema: object) => schema,
		String: (options: object = {}) => ({ type: "string", ...options }),
	},
}));
mock.module("@earendil-works/pi-tui", () => ({
	Box: class {},
	Container: class {},
	Text: class {
		constructor(private text: string) {}
		render() { return [this.text]; }
	},
	truncateToWidth: (text: string) => text,
	visibleWidth: (text: string) => text.length,
}));

const { default: goalExtension } = await import("../goal/index.ts");
const { default: codexCompactionExtension } = await import("./index.ts");
const {
	buildReplacementHistory,
	callRemoteCompaction,
	effectiveInputForBranch,
	findNativeCheckpoint,
	mergeFeatureHeader,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	retainRecentUserMessages,
} = await import("./native-compaction.ts");

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function token(): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
	})).toString("base64url");
	return `header.${payload}.signature`;
}

const model = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 16_384,
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0, total: 0 },
} as any;

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	} as SessionEntry;
}

function goalEntry(id: string, parentId: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		customType: "goal-state",
		data: {
			objective: "Finish the task",
			status: "active",
			activeSince: Date.now(),
		},
	} as SessionEntry;
}

function extensionHarness(
	initialBranch: SessionEntry[],
	includeGoal = false,
	goalFirst = false,
	activeModel = model,
) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const eventHandlers = new Map<string, Array<(data: any) => void>>();
	const emittedEvents: Array<{ name: string; data: any }> = [];
	const entryRenderers = new Map<string, (...args: any[]) => any>();
	let branch = initialBranch;
	let aborted = false;
	let hasPendingMessages = false;
	let idle = false;
	let usageTokens = 40_000;
	let sessionId = "session-123";
	let customEntryId = 0;
	const notifications: string[] = [];
	const statuses = new Map<string, string>();
	const widgets = new Map<string, string[]>();
	const compactionRequests: any[] = [];
	const sentUserMessages: Array<{ content: string; options: any }> = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	let activeTools: string[] = [];
	const pi = {
		events: {
			on(name: string, handler: (data: any) => void) {
				eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
				return () => eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler));
			},
			emit(name: string, data: any) {
				emittedEvents.push({ name, data });
				for (const handler of eventHandlers.get(name) ?? []) handler(data);
			},
		},
		on(name: string, handler: (...args: any[]) => any) {
			const previous = handlers.get(name);
			handlers.set(name, previous
				? async (...args: any[]) => {
					await previous(...args);
					return handler(...args);
				}
				: handler);
		},
		getAllTools: () => [...tools.values()],
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) { activeTools = [...names]; },
		registerTool(tool: any) {
			tools.set(tool.name, tool);
			activeTools.push(tool.name);
		},
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerEntryRenderer(customType: string, renderer: (...args: any[]) => any) {
			entryRenderers.set(customType, renderer);
		},
		appendEntry(customType: string, data: unknown) {
			branch = [...branch, {
				type: "custom",
				id: `custom-${++customEntryId}`,
				parentId: branch.at(-1)?.id ?? null,
				timestamp: new Date().toISOString(),
				customType,
				data,
			} as SessionEntry];
		},
		sendUserMessage(content: string, options?: any) {
			sentUserMessages.push({ content, options });
		},
		sendMessage(message: any, options?: any) {
			sentMessages.push({ message, options });
		},
	} as any;
	if (includeGoal && goalFirst) goalExtension(pi);
	codexCompactionExtension(pi);
	if (includeGoal && !goalFirst) goalExtension(pi);

	const context = {
		model: activeModel,
		mode: "tui",
		cwd: "/var/tmp/pi-codex-compaction-test",
		signal: new AbortController().signal,
		hasUI: true,
		ui: {
			theme: { fg: (_role: string, text: string) => text },
			setStatus(key: string, value: string | undefined) {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
			setWidget(key: string, value: string[] | undefined) {
				if (value === undefined) widgets.delete(key);
				else widgets.set(key, value);
			},
			notify: (message: string) => notifications.push(message),
		},
		abort: () => { aborted = true; },
		compact: (options: any) => { compactionRequests.push(options); },
		isIdle: () => idle,
		isProjectTrusted: () => false,
		hasPendingMessages: () => hasPendingMessages,
		getContextUsage: () => ({
			tokens: usageTokens,
			contextWindow: activeModel.contextWindow,
			percent: (usageTokens / activeModel.contextWindow) * 100,
		}),
		getSystemPrompt: () => "You are Codex.",
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => "/tmp/session.jsonl",
			getEntries: () => branch,
			getBranch: () => branch,
			getLeafId: () => branch.at(-1)?.id ?? null,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token(), headers: {} }),
			getProviderAuth: async () => ({ auth: { apiKey: token(), baseUrl: model.baseUrl } }),
			getProvider: () => ({ baseUrl: model.baseUrl }),
		},
	};

	return {
		handlers,
		context,
		setBranch(next: SessionEntry[]) { branch = next; },
		setHasPendingMessages(pending: boolean) { hasPendingMessages = pending; },
		setIdle(value: boolean) { idle = value; },
		setUsageTokens(tokens: number) { usageTokens = tokens; },
		setSessionId(value: string) { sessionId = value; },
		getBranch() { return branch; },
		get aborted() { return aborted; },
		entryRenderers,
		commands,
		notifications,
		statuses,
		widgets,
		compactionRequests,
		sentUserMessages,
		sentMessages,
		emittedEvents,
		emitSharedEvent(name: string, data: unknown) { pi.events.emit(name, data); },
	};
}

function compactionSse(encryptedContent = "opaque-state"): Response {
	const events = [
		{
			type: "response.output_item.done",
			item: { type: "compaction", id: "cmp_1", encrypted_content: encryptedContent },
		},
		{
			type: "response.completed",
			response: {
				usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
			},
		},
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("pi-codex-compaction", () => {
	test("advertises native Codex ownership without claiming other providers", () => {
		const harness = extensionHarness([]);
		const codex = { provider: "openai-codex", api: "openai-codex-responses", available: false };
		const other = { provider: "anthropic", api: "anthropic-messages", available: false };

		harness.emitSharedEvent("tripp:codex-compaction:v1:capability", codex);
		harness.emitSharedEvent("tripp:codex-compaction:v1:capability", other);

		expect(codex.available).toBe(true);
		expect(other.available).toBe(false);
	});

	test("continues an unfinished tool turn only after threshold compaction succeeds", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue")]);
		harness.setUsageTokens(210_000);
		await harness.handlers.get("turn_end")!({
			message: { stopReason: "toolUse" }, toolResults: [{}],
		}, harness.context);
		expect(harness.compactionRequests).toHaveLength(1);
		expect(harness.sentMessages).toHaveLength(0);
		harness.compactionRequests[0].onComplete();
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	});

	test("does not continue failed compaction, replaced sessions, or queued work", async () => {
		for (const outcome of ["failure", "shutdown", "queued"]) {
			const harness = extensionHarness([userEntry("user-1", "continue")]);
			harness.setUsageTokens(210_000);
			await harness.handlers.get("turn_end")!({
				message: { stopReason: "toolUse" }, toolResults: [{}],
			}, harness.context);
			const request = harness.compactionRequests[0];
			if (outcome === "failure") request.onError(new Error("cancelled"));
			else {
				if (outcome === "shutdown") await harness.handlers.get("session_shutdown")!({}, harness.context);
				if (outcome === "queued") harness.setHasPendingMessages(true);
				request.onComplete();
			}
			expect(harness.sentMessages).toHaveLength(0);
		}
	});

	test("does not restart finished or terminating tool turns", async () => {
		for (const event of [
			{ message: { stopReason: "stop" }, toolResults: [] },
			{ message: { stopReason: "aborted" }, toolResults: [{}] },
			{ message: { stopReason: "toolUse" }, toolResults: [{ terminate: true }] },
		]) {
			const harness = extensionHarness([userEntry("user-1", "continue")]);
			harness.setUsageTokens(210_000);
			await harness.handlers.get("turn_end")!(event, harness.context);
			expect(harness.compactionRequests).toHaveLength(0);
		}
	});

	test("persists the session threshold and schedules compaction when reached", async () => {
		const entry = userEntry("user-1", "continue the task");
		const harness = extensionHarness([entry]);
		const command = harness.commands.get("threshold");

		await command.handler("", harness.context);
		expect(harness.notifications.at(-1)).toBe("Compaction threshold: 200,000 tokens (default).");

		await command.handler("180k", harness.context);
		expect(harness.notifications.at(-1)).toBe("Compaction threshold set to 180,000 tokens for this session.");
		expect(harness.getBranch().at(-1)).toMatchObject({
			type: "custom",
			customType: "codex-compaction-threshold-state",
			data: { tokens: 180_000 },
		});
		await harness.handlers.get("session_start")!({}, harness.context);
		await command.handler("", harness.context);
		expect(harness.notifications.at(-1)).toBe("Compaction threshold: 180,000 tokens (session override).");
		harness.setSessionId("session-456");
		await command.handler("", harness.context);
		expect(harness.notifications.at(-1)).toBe("Compaction threshold: 200,000 tokens (default).");
		harness.setSessionId("session-123");

		harness.setUsageTokens(179_999);
		await harness.handlers.get("agent_settled")!({}, harness.context);
		expect(harness.compactionRequests).toHaveLength(0);

		harness.setUsageTokens(180_000);
		await harness.handlers.get("agent_settled")!({}, harness.context);
		expect(harness.compactionRequests).toHaveLength(1);
	});

	test("schedules Astra compaction at its lower default threshold", async () => {
		const astra = { ...model, id: "gpt-6-astra", contextWindow: 272_000 };
		const harness = extensionHarness([userEntry("user-1", "continue the task")], false, false, astra);
		const command = harness.commands.get("threshold");

		await command.handler("", harness.context);
		expect(harness.notifications.at(-1)).toBe("Compaction threshold: 150,000 tokens (default).");

		harness.setUsageTokens(149_999);
		await harness.handlers.get("agent_settled")!({}, harness.context);
		expect(harness.compactionRequests).toHaveLength(0);

		harness.setUsageTokens(150_000);
		await harness.handlers.get("agent_settled")!({}, harness.context);
		expect(harness.compactionRequests).toHaveLength(1);
	});

	test("uses the advertised default threshold without requiring a stored override", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")]);
		harness.setUsageTokens(199_999);
		await harness.handlers.get("agent_settled")!({}, harness.context);
		expect(harness.compactionRequests).toHaveLength(0);

		harness.setUsageTokens(200_000);
		await harness.handlers.get("agent_settled")!({}, harness.context);
		expect(harness.compactionRequests).toHaveLength(1);
	});

	test("supports threshold overrides for non-Codex models", async () => {
		const anthropicModel = { ...model, provider: "anthropic", api: "anthropic-messages", contextWindow: 128_000 };
		const lower = extensionHarness([userEntry("user-1", "continue the task")], false, false, anthropicModel);
		const lowerCommand = lower.commands.get("threshold");

		await lowerCommand.handler("90k", lower.context);
		lower.setUsageTokens(89_999);
		await lower.handlers.get("agent_settled")!({}, lower.context);
		expect(lower.compactionRequests).toHaveLength(0);
		lower.setUsageTokens(90_000);
		await lower.handlers.get("agent_settled")!({}, lower.context);
		expect(lower.compactionRequests).toHaveLength(1);

		const higher = extensionHarness([userEntry("user-1", "continue the task")], false, false, anthropicModel);
		const higherCommand = higher.commands.get("threshold");
		await higherCommand.handler("120k", higher.context);
		higher.setUsageTokens(100_000);
		expect(await higher.handlers.get("session_before_compact")!({
			branchEntries: higher.getBranch(),
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 100_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, higher.context)).toEqual({ cancel: true });
		higher.setUsageTokens(120_000);
		expect(await higher.handlers.get("session_before_compact")!({
			branchEntries: higher.getBranch(),
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 100_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, higher.context)).toBeUndefined();
	});

	test("restores the override after reload and holds Pi's configured threshold using provider usage", async () => {
		let called = false;
		globalThis.fetch = (async () => { called = true; return compactionSse(); }) as typeof fetch;
		const entry = userEntry("user-1", "continue the task");
		const original = extensionHarness([entry]);
		await original.commands.get("threshold").handler("190,000", original.context);
		await original.handlers.get("session_shutdown")!({}, original.context);

		const reloaded = extensionHarness(original.getBranch());
		reloaded.setUsageTokens(150_000);
		await reloaded.handlers.get("session_start")!({}, reloaded.context);
		expect(await reloaded.handlers.get("session_before_compact")!({
			branchEntries: reloaded.getBranch(),
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 195_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, reloaded.context)).toEqual({ cancel: true });
		expect(called).toBe(false);
	});

	test("rejects invalid or unsafe threshold values", async () => {
		const harness = extensionHarness([userEntry("user-1", "hello")]);
		const command = harness.commands.get("threshold");

		await command.handler("many", harness.context);
		expect(harness.notifications.at(-1)).toContain("Usage: /threshold");
		await command.handler(`${model.contextWindow}`, harness.context);
		expect(harness.notifications.at(-1)).toContain("must be below");
	});

	test("runs native compaction and never replays the local marker", async () => {
		let requestBody: JsonObject | undefined;
		let requestHeaders: Headers | undefined;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body));
			requestHeaders = new Headers(init?.headers);
			return compactionSse();
		}) as typeof fetch;

		const firstUser = userEntry("user-1", "Remember BLUE-42.");
		const harness = extensionHarness([firstUser]);
		const compact = harness.handlers.get("session_before_compact")!;
		const result = await compact({
			branchEntries: [firstUser],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect(result.cancel).toBeUndefined();
		expect(result.compaction.summary).toContain("OpenAI Codex native compaction checkpoint");
		expect(result.compaction.details.kind).toBe(NATIVE_COMPACTION_KIND);
		expect(result.compaction.details.version).toBe(NATIVE_COMPACTION_VERSION);
		expect(result.compaction.details.sessionId).toBe("session-123");
		expect(result.compaction.details.sourceLeafId).toBe("user-1");
		expect(result.compaction.details.replacementHistory.at(-1)).toEqual({
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "opaque-state",
		});
		expect((requestBody!.input as JsonObject[]).at(-1)).toEqual({ type: "compaction_trigger" });
		expect(JSON.stringify(requestBody)).not.toContain("checkpoint");
		expect(requestHeaders!.get("x-codex-beta-features")).toContain("remote_compaction_v2");
		expect(harness.statuses.get("codex-compaction")).toBe("Codex compacting 0s");
		expect(harness.widgets.get("codex-compaction")?.[0]).toBe(
			"Codex compaction: waiting for OpenAI — 0s elapsed (300s timeout)",
		);
		expect(harness.getBranch()).toEqual([firstUser]);

		const compactionEntry = {
			type: "compaction",
			id: "compact-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			summary: result.compaction.summary,
			firstKeptEntryId: "user-1",
			tokensBefore: 50_000,
			details: result.compaction.details,
		} as SessionEntry;
		harness.setBranch([firstUser, compactionEntry]);
		await harness.handlers.get("session_compact")!({ compactionEntry }, harness.context);
		expect(harness.statuses.has("codex-compaction")).toBe(false);
		expect(harness.widgets.has("codex-compaction")).toBe(false);
		expect(harness.emittedEvents.map((event) => event.name)).toEqual([
			"tripp:codex-compaction:v1:started",
			"tripp:codex-compaction:v1:committed",
		]);
		const nextUser = {
			...userEntry("user-2", "What was the code?"),
			parentId: "compact-1",
		} as SessionEntry;
		harness.setBranch([firstUser, compactionEntry, nextUser]);

		const beforeRequest = harness.handlers.get("before_provider_request")!;
		const markerPayload = {
			model: model.id,
			input: [{ role: "user", content: [{ type: "input_text", text: result.compaction.summary }] }],
		};
		const patched = await beforeRequest({ payload: markerPayload }, harness.context);
		const serialized = JSON.stringify(patched);
		expect(serialized).not.toContain(result.compaction.summary);
		expect(patched.input[0]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "Remember BLUE-42." }],
		});
		expect(patched.input[1]).toEqual({ type: "compaction", id: "cmp_1", encrypted_content: "opaque-state" });
		expect(patched.input[2]).toMatchObject({ role: "user" });

		const filteredContext = harness.handlers.get("context")!({
			messages: [
				{ role: "compactionSummary", summary: result.compaction.summary },
				{ role: "user", content: [{ type: "text", text: "What was the code?" }] },
			],
		}, harness.context);
		expect(filteredContext.messages).toHaveLength(1);
		expect(filteredContext.messages[0].role).toBe("user");
	});

	test("uses Astra's low-reasoning priority profile and current Codex routing headers", async () => {
		let requestBody: JsonObject | undefined;
		let requestHeaders: Headers | undefined;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body));
			requestHeaders = new Headers(init?.headers);
			return compactionSse();
		}) as typeof fetch;
		const astra = { ...model, id: "gpt-6-astra", contextWindow: 272_000 };
		const entry = userEntry("user-1", "Remember BLUE-42.");
		const harness = extensionHarness([entry], false, false, astra);
		const providerTools = [{ type: "function", name: "provider-visible", parameters: { type: "object" } }];

		const liveHeaders: Record<string, string | null> = {};
		await harness.handlers.get("before_provider_headers")!({ headers: liveHeaders }, harness.context);
		await harness.handlers.get("before_provider_request")!({
			payload: {
				model: astra.id,
				input: [],
				reasoning: { effort: "xhigh", summary: "detailed" },
				service_tier: "default",
				tools: providerTools,
			},
		}, harness.context);
		await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 150_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect(liveHeaders.version).toBe("0.153.0");
		expect(requestBody?.reasoning).toEqual({ effort: "low", summary: "detailed" });
		expect(requestBody?.service_tier).toBe("priority");
		expect(requestBody?.tools).toEqual(providerTools);
		expect(requestHeaders?.get("version")).toBe("0.153.0");
		expect(requestHeaders?.get("x-codex-routing-hint")).toBe("model=gpt-6-astra;tier=priority");
	});

	test("finishes active-goal compaction at response.completed without waiting for stream EOF", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let streamCancelled = false;
		const events = [
			{
				type: "response.output_item.done",
				item: { type: "compaction", id: "cmp_1", encrypted_content: "persistent-stream-opaque" },
			},
			{
				type: "response.completed",
				response: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } },
			},
		];
		globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				streamController = controller;
				controller.enqueue(new TextEncoder().encode(
					events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
				));
			},
			cancel() {
				streamCancelled = true;
			},
		}), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		})) as typeof fetch;

		const entry = userEntry("user-1", "continue the active goal");
		const initial = [entry, goalEntry("goal-1", "user-1")];
		const harness = extensionHarness(initial, true);
		await harness.handlers.get("session_start")!({}, harness.context);
		const pending = harness.handlers.get("session_before_compact")!({
			branchEntries: initial,
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);
		const timeout = Symbol("timeout");
		const result = await Promise.race([
			pending,
			Bun.sleep(250).then(() => timeout),
		]);
		if (result === timeout) {
			streamController?.close();
			await pending;
			throw new Error("Compaction kept waiting after response.completed.");
		}

		expect(result.compaction.details.replacementHistory.at(-1)).toEqual({
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "persistent-stream-opaque",
		});
		expect(streamCancelled).toBe(true);
	});

	test("zstd-compresses large remote compaction requests", async () => {
		let requestBody: BodyInit | null | undefined;
		let requestHeaders: Headers | undefined;
		const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = init?.body;
			requestHeaders = new Headers(init?.headers);
			return compactionSse();
		}) as typeof fetch;

		await callRemoteCompaction({
			url: "https://example.test/codex/responses",
			headers: new Headers({ "content-type": "application/json" }),
			body: { input: "x".repeat(70_000) },
			model,
			fetchImpl,
		});

		expect(requestHeaders?.get("content-encoding")).toBe("zstd");
		const zlib = process.getBuiltinModule("node:zlib");
		const decoded = zlib.zstdDecompressSync(requestBody as Uint8Array).toString();
		expect(JSON.parse(decoded)).toEqual({ input: "x".repeat(70_000) });
	});

	test("times out a remote request that never returns", async () => {
		let requestSignal: AbortSignal | undefined;
		const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			requestSignal = init?.signal ?? undefined;
			requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
		})) as typeof fetch;

		const startedAt = Date.now();
		await expect(callRemoteCompaction({
			url: "https://example.test/codex/responses",
			headers: new Headers(),
			body: {},
			model,
			fetchImpl,
			timeoutMs: 20,
		})).rejects.toThrow("timed out after 1 seconds");

		expect(requestSignal?.aborted).toBe(true);
		expect(Date.now() - startedAt).toBeLessThan(250);
	});

	test("times out a remote stream that never completes", async () => {
		let streamCancelled = false;
		const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
			cancel() { streamCancelled = true; },
		}), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		})) as typeof fetch;

		await expect(callRemoteCompaction({
			url: "https://example.test/codex/responses",
			headers: new Headers(),
			body: {},
			model,
			fetchImpl,
			timeoutMs: 20,
		})).rejects.toThrow("timed out after 1 seconds");

		expect(streamCancelled).toBe(true);
	});

	test("cancels Pi compaction instead of falling back to text summarization", async () => {
		globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
		const entry = userEntry("user-1", "hello");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect(result).toEqual({ cancel: true });
		expect(harness.notifications[0]).toContain("native compaction failed");
		await harness.handlers.get("session_compact_failed")!({ errorMessage: "bad request" }, harness.context);
		expect(harness.emittedEvents.map((event) => event.name)).toEqual([
			"tripp:codex-compaction:v1:started",
			"tripp:codex-compaction:v1:failed",
		]);
	});

	test("retries a message-less compaction stream error", async () => {
		let attempts = 0;
		globalThis.fetch = (async () => {
			attempts++;
			if (attempts === 1) {
				return new Response(`data: ${JSON.stringify({ type: "error" })}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return compactionSse("retried-opaque");
		}) as typeof fetch;
		const entry = userEntry("user-1", "continue after a transient compaction failure");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect(attempts).toBe(2);
		expect(result.compaction.details.replacementHistory.at(-1)).toEqual({
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "retried-opaque",
		});
		expect(harness.getBranch()).toEqual([entry]);
	});

	test("does not retry an explicit compaction stream error", async () => {
		let attempts = 0;
		globalThis.fetch = (async () => {
			attempts++;
			return new Response(`data: ${JSON.stringify({ type: "error", message: "explicit failure" })}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;
		const entry = userEntry("user-1", "do not retry a permanent compaction failure");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect(attempts).toBe(1);
		expect(result).toEqual({ cancel: true });
		expect(harness.notifications).toContain("OpenAI Codex native compaction failed: explicit failure");
	});

	test("keeps the source leaf stable while Pi awaits native compaction", async () => {
		let resolveFetch: ((response: Response) => void) | undefined;
		globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as typeof fetch;
		const entry = userEntry("user-1", "continue the task");
		const harness = extensionHarness([entry]);
		const pending = harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		expect(harness.getBranch()).toEqual([entry]);
		expect(harness.emittedEvents.map((event) => event.name)).toEqual([
			"tripp:codex-compaction:v1:started",
		]);
		await Promise.resolve();
		resolveFetch!(compactionSse());
		const result = await pending;
		expect(result.compaction.details.sourceLeafId).toBe("user-1");
		expect(result.compaction.details.sessionId).toBe("session-123");
	});

	test("does not schedule, abort, or continue below the default threshold", async () => {
		let called = false;
		globalThis.fetch = (async () => { called = true; return compactionSse(); }) as typeof fetch;
		const entry = userEntry("user-1", "continue the tool-driven task");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("before_provider_request")!({
			payload: { model: model.id, input: [{ role: "user", content: [] }] },
		}, harness.context);

		expect(result).toBeUndefined();
		expect(called).toBe(false);
		await harness.handlers.get("turn_end")!({
			message: { stopReason: "toolUse" }, toolResults: [{}],
		}, harness.context);
		await harness.handlers.get("agent_settled")!({}, harness.context);
		expect(harness.compactionRequests).toHaveLength(0);
		expect(harness.sentUserMessages).toHaveLength(0);
	});

	test("passively holds goal continuation in both extension load orders", async () => {
		for (const goalFirst of [false, true]) {
			globalThis.fetch = (async () => compactionSse()) as typeof fetch;
			const firstUser = userEntry("user-1", "continue the task");
			const initial = [firstUser, goalEntry("goal-1", "user-1")];
			const harness = extensionHarness(initial, true, goalFirst);
			await harness.handlers.get("session_start")!({}, harness.context);
			harness.sentMessages.length = 0;

			const result = await harness.handlers.get("session_before_compact")!({
				branchEntries: initial,
				preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			}, harness.context);
			await harness.handlers.get("agent_settled")!({}, harness.context);
			expect(harness.sentMessages).toHaveLength(0);

			const compactionEntry = {
				type: "compaction",
				id: "compaction-1",
				parentId: "goal-1",
				timestamp: new Date().toISOString(),
				summary: result.compaction.summary,
				firstKeptEntryId: "user-1",
				tokensBefore: 50_000,
				details: result.compaction.details,
			} as SessionEntry;
			harness.setBranch([...initial, compactionEntry]);
			await harness.handlers.get("session_compact")!({ compactionEntry }, harness.context);
			expect(harness.sentMessages).toHaveLength(0);

			harness.setIdle(true);
			await harness.handlers.get("agent_settled")!({}, harness.context);
			expect(harness.sentMessages).toHaveLength(0);
			await Bun.sleep(5);
			expect(harness.sentMessages).toHaveLength(1);
			expect(harness.sentMessages[0].message.customType).toBe("goal-continuation");
			expect(harness.emittedEvents.map((event) => event.name)).toEqual([
				"tripp:codex-compaction:v1:started",
				"tripp:codex-compaction:v1:committed",
			]);
		}
	});

	test("fails a stale compaction request before checkpoint commit", async () => {
		let resolveFetch: ((response: Response) => void) | undefined;
		globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as typeof fetch;
		const entry = userEntry("user-1", "continue the task");
		const harness = extensionHarness([entry]);
		const pending = harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		await Promise.resolve();
		harness.setBranch([entry, { ...userEntry("user-2", "arrived during compaction"), parentId: "user-1" } as SessionEntry]);
		resolveFetch!(compactionSse());
		expect(await pending).toEqual({ cancel: true });
		await harness.handlers.get("session_compact_failed")!({}, harness.context);
		expect(harness.emittedEvents.map((event) => event.name)).toEqual([
			"tripp:codex-compaction:v1:started",
			"tripp:codex-compaction:v1:failed",
		]);
		expect(harness.notifications.at(-1)).toContain("Session changed while Codex compaction was running");
	});

	test("leaves non-Codex providers untouched", async () => {
		const entry = userEntry("user-1", "hello");
		const harness = extensionHarness([entry]);
		const otherContext = {
			...harness.context,
			model: { ...model, provider: "anthropic", api: "anthropic-messages" },
		};

		expect(await harness.handlers.get("before_provider_request")!({ payload: { input: ["original"] } }, otherContext)).toBeUndefined();
		expect(await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, otherContext)).toBeUndefined();
	});

	test("aborts rather than sending a malformed local checkpoint", async () => {
		const firstUser = userEntry("user-1", "hello");
		const malformed = {
			type: "compaction",
			id: "compact-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			summary: "local marker",
			firstKeptEntryId: "user-1",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: "bad",
				replacementHistory: [],
			},
		} as SessionEntry;
		const harness = extensionHarness([firstUser, malformed]);
		const patched = await harness.handlers.get("before_provider_request")!({
			payload: { model: model.id, input: [{ role: "user", content: "local marker" }] },
		}, harness.context);

		expect(harness.aborted).toBe(true);
		expect(patched.input).toEqual([]);
		expect(JSON.stringify(patched)).not.toContain("local marker");
	});
});

describe("native compaction helpers", () => {
	test("drops foreign reasoning state and response item ids", () => {
		const user = userEntry("user-1", "review this change");
		const assistant = {
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				provider: "xai",
				api: "openai-responses",
				model: "grok-4.6",
				stopReason: "toolUse",
				timestamp: Date.now(),
				content: [
					{
						type: "thinking",
						thinking: "checking",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							id: "rs_grok_1",
							status: "completed",
							summary: [{ type: "summary_text", text: "checking" }],
							encrypted_content: "opaque-grok-state",
						}),
					},
					{
						type: "text",
						text: "Looks good.",
						textSignature: JSON.stringify({ v: 1, id: "msg_grok_1" }),
					},
					{
						type: "toolCall",
						id: "call_grok_1|fc_grok_1",
						name: "bash",
						arguments: { command: "git status" },
					},
				],
			},
		} as SessionEntry;
		const toolResult = {
			type: "message",
			id: "tool-result-1",
			parentId: "assistant-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "call_grok_1|fc_grok_1",
				toolName: "bash",
				content: [{ type: "text", text: "clean" }],
				isError: false,
				timestamp: Date.now(),
			},
		} as SessionEntry;

		const input = effectiveInputForBranch({ branch: [user, assistant, toolResult], model, tools: [] });
		const assistantMessage = input.find(
			(item) => item.type === "message" && item.role === "assistant",
		)!;
		const functionCall = input.find((item) => item.type === "function_call")!;

		expect(input.find((item) => item.type === "reasoning")).toBeUndefined();
		expect(JSON.stringify(input)).not.toContain("opaque-grok-state");
		expect(assistantMessage.status).toBeUndefined();
		expect(assistantMessage.id).toBe("msg_pi_1");
		expect(functionCall.call_id).toBe("call_grok_1");
		expect(functionCall.id).toBeUndefined();
	});

	test("removes response-only status from Codex reasoning", () => {
		const user = userEntry("user-1", "continue");
		const assistant = {
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "stop",
				timestamp: Date.now(),
				content: [{
					type: "thinking",
					thinking: "checking",
					thinkingSignature: JSON.stringify({
						type: "reasoning",
						id: "rs_codex_1",
						status: "completed",
						summary: [],
						encrypted_content: "opaque-codex-state",
					}),
				}],
			},
		} as SessionEntry;

		const input = effectiveInputForBranch({ branch: [user, assistant], model, tools: [] });
		const reasoning = input.find((item) => item.type === "reasoning")!;
		expect(reasoning.status).toBeUndefined();
		expect(reasoning.encrypted_content).toBe("opaque-codex-state");
	});

	test("retains only recent user messages before the opaque item", () => {
		const input = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] },
			{ type: "function_call", call_id: "call-1" },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
		] as any;
		const retained = retainRecentUserMessages(input);
		expect(retained).toHaveLength(2);
		expect(retained.every((item) => item.role === "user")).toBe(true);

		const replacement = buildReplacementHistory(input, { type: "compaction", encrypted_content: "opaque" });
		expect(replacement.at(-1)).toEqual({ type: "compaction", encrypted_content: "opaque" });
	});

	test("repeated compaction replaces rather than nests the old opaque item", () => {
		const firstUser = userEntry("user-1", "old user fact");
		const firstCheckpoint = {
			type: "compaction",
			id: "compact-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			summary: "local marker 1",
			firstKeptEntryId: "user-1",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: 1,
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [
					{ role: "user", content: [{ type: "input_text", text: "old user fact" }] },
					{ type: "compaction", encrypted_content: "opaque-1" },
				],
			},
		} as SessionEntry;
		const nextUser = { ...userEntry("user-2", "new user fact"), parentId: "compact-1" } as SessionEntry;
		const input = effectiveInputForBranch({
			branch: [firstUser, firstCheckpoint, nextUser],
			model,
			tools: [],
		});
		expect(input.filter((item) => item.type === "compaction")).toHaveLength(1);

		const replacement = buildReplacementHistory(input, {
			type: "compaction",
			encrypted_content: "opaque-2",
		});
		expect(replacement.filter((item) => item.type === "compaction")).toEqual([
			{ type: "compaction", encrypted_content: "opaque-2" },
		]);
		expect(JSON.stringify(replacement)).toContain("new user fact");
	});

	test("overflow recovery excludes the failed assistant response", () => {
		const user = userEntry("user-1", "large request");
		const failure = {
			type: "message",
			id: "assistant-error",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "context window exceeded" }],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "error",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const input = effectiveInputForBranch({
			branch: [user, failure],
			model,
			tools: [],
			excludeLastAssistantError: true,
		});
		expect(JSON.stringify(input)).not.toContain("context window exceeded");
		expect(JSON.stringify(input)).toContain("large request");
	});

	test("does not replay partial tool calls from an aborted assistant after a checkpoint", () => {
		const checkpoint = {
			type: "custom",
			id: "checkpoint",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: NATIVE_COMPACTION_KIND,
			data: {
				kind: NATIVE_COMPACTION_KIND,
				version: 1,
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			},
		} as SessionEntry;
		const aborted = {
			type: "message",
			id: "assistant-aborted",
			parentId: "checkpoint",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{
					type: "toolCall",
					id: "call-aborted|fc_aborted",
					name: "edit",
					arguments: { path: "src/client/input.rs" },
				}],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "aborted",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const user = { ...userEntry("user-after-abort", "what happened?"), parentId: "assistant-aborted" } as SessionEntry;

		const input = effectiveInputForBranch({ branch: [checkpoint, aborted, user], model, tools: [] });
		expect(JSON.stringify(input)).not.toContain("call-aborted");
		expect(JSON.stringify(input)).toContain("what happened?");
	});

	test("rebuilds raw history when a legacy checkpoint splits a tool call from its output", () => {
		const user = userEntry("user-1", "continue the work");
		const assistant = {
			type: "message",
			id: "assistant-sleep",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{
					type: "toolCall",
					id: "call_Rea2zJSjORfIMMb613kQf12q|fc_06bf59a69e32cf7f016a95965f4f8887d1ab3ea56d615bfe25",
					name: "sleep",
					arguments: { seconds: 10 },
				}],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const checkpoint = {
			type: "compaction",
			id: "legacy-checkpoint",
			parentId: "assistant-sleep",
			timestamp: new Date().toISOString(),
			summary: "legacy local marker must not be replayed",
			firstKeptEntryId: "user-1",
			tokensBefore: 225_780,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: 1,
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [{ type: "compaction", encrypted_content: "poisoned-legacy-opaque" }],
			},
		} as SessionEntry;
		const output = {
			type: "message",
			id: "sleep-output",
			parentId: "legacy-checkpoint",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "call_Rea2zJSjORfIMMb613kQf12q|fc_06bf59a69e32cf7f016a95965f4f8887d1ab3ea56d615bfe25",
				toolName: "sleep",
				content: [{ type: "text", text: "Slept for 10s" }],
				isError: false,
				timestamp: Date.now(),
			},
		} as SessionEntry;

		const input = effectiveInputForBranch({
			branch: [user, assistant, checkpoint, output],
			model,
			tools: [],
		});

		expect(input.map((item) => item.type ?? item.role)).toEqual([
			"user",
			"function_call",
			"function_call_output",
		]);
		expect(input[1]?.call_id).toBe("call_Rea2zJSjORfIMMb613kQf12q");
		expect(input[2]?.call_id).toBe("call_Rea2zJSjORfIMMb613kQf12q");
		expect(JSON.stringify(input)).not.toContain("poisoned-legacy-opaque");
		expect(JSON.stringify(input)).not.toContain("legacy local marker");
	});

	test("does not rebuild raw history for a version 2 checkpoint with an orphaned tail", () => {
		const checkpoint = {
			type: "compaction",
			id: "current-checkpoint",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "current marker",
			firstKeptEntryId: "user-1",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				checkpointId: "checkpoint-1",
				sessionId: "session-123",
				sourceLeafId: "user-1",
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			},
		} as SessionEntry;
		const output = {
			type: "message",
			id: "tool-result-1",
			parentId: "current-checkpoint",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "call-missing|fc_missing",
				toolName: "sleep",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		} as SessionEntry;

		expect(() => effectiveInputForBranch({
			branch: [checkpoint, output],
			model,
			tools: [],
			sessionId: "session-123",
		})).toThrow("orphaned tool output: call-missing|fc_missing");
	});

	test("drops unresolved tool calls when later input supersedes the interrupted turn", () => {
		const assistant = {
			type: "message",
			id: "assistant-tool",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-bash|fc_bash", name: "bash", arguments: {} },
					{ type: "toolCall", id: "call-goal|fc_goal", name: "get_goal", arguments: {} },
				],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const user = { ...userEntry("user-after-tool", "continue"), parentId: "assistant-tool" } as SessionEntry;

		const input = effectiveInputForBranch({ branch: [assistant, user], model, tools: [] });
		expect(input.filter((item) => item.type === "function_call")).toHaveLength(0);
		expect(JSON.stringify(input)).toContain("continue");
	});

	test("rejects a tool output without a preceding function call", () => {
		const output = {
			type: "message",
			id: "tool-result-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "call-missing|fc_missing",
				toolName: "sleep",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		} as SessionEntry;

		expect(() => effectiveInputForBranch({ branch: [output], model, tools: [] }))
			.toThrow("orphaned tool output: call-missing|fc_missing");
	});

	test("rejects a version 2 checkpoint from another session", () => {
		const checkpoint = {
			type: "compaction",
			id: "native",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "marker",
			firstKeptEntryId: "user",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				checkpointId: "checkpoint-1",
				sessionId: "other-session",
				sourceLeafId: "user",
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			},
		} as SessionEntry;

		expect(() => effectiveInputForBranch({ branch: [checkpoint], model, tools: [], sessionId: "session-123" }))
			.toThrow("belongs to a different session");
	});

	test("latest compaction on the active branch is authoritative", () => {
		const native = {
			type: "compaction",
			id: "native",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "marker",
			firstKeptEntryId: "user",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: 1,
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			},
		} as SessionEntry;
		expect(findNativeCheckpoint([native]).status).toBe("valid");
		expect(findNativeCheckpoint([native, { ...native, id: "local", details: {} } as SessionEntry]).status).toBe("none");
	});

	test("merges the beta feature without removing existing features", () => {
		expect(mergeFeatureHeader("foo, remote_compaction_v2")).toBe("foo,remote_compaction_v2");
	});
});
