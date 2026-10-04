import { expect, test } from "bun:test";
import { type AssistantMessage, type Context, type Message, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionVirtualModel } from "@earendil-works/pi-coding-agent";
import council, { advisorContext, adviceMessage, MODEL_ID, OPENAI_MODEL_ID, PROVIDER, TURN_BUDGET, type CouncilState } from "./index.ts";

const usage = { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const messages = [{ role: "user" as const, content: "Fix the parser", timestamp: 1 }];

function response(model: Model<any>, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: [{ type: "text", text: "Inspect the parser, fix it, and test it." }],
		stopReason: "stop", usage, timestamp: 1, ...overrides };
}

function harness(modelId = MODEL_ID) {
	const definitions = new Map<string, ExtensionVirtualModel<CouncilState>>();
	const handlers = new Map<string, Function>();
	const calls: { model: Model<any>; context: Context; options: SimpleStreamOptions }[] = [];
	const branch: any[] = [{ type: "message", id: "task-1", message: messages[0] }];
	const statuses: (string | undefined)[] = [];
	const models = ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5"].map(id => ({
		id, provider: id.startsWith("claude") ? "anthropic" : "openai", api: "fixture",
		name: id, baseUrl: "https://fixture.invalid", reasoning: true, input: ["text"],
		contextWindow: 200_000, maxTokens: 100_000, cost: usage.cost,
	})) as Model<any>[];
	let answer = (model: Model<any>) => Promise.resolve(response(model));
	let aborted = false;
	const ctx: any = {
		model: { id: modelId, provider: PROVIDER },
		sessionManager: { getBranch: () => branch },
		modelRegistry: {
			find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
			hasConfiguredAuth: () => true,
			streamSimple: (model: Model<any>, context: Context, options: SimpleStreamOptions) => {
				calls.push({ model, context, options });
				return { result: () => answer(model) };
			},
		},
		ui: { setStatus(_key: string, value?: string) { statuses.push(value); } },
		abort: () => { aborted = true; },
	};
	council({ registerVirtualModel: (model: ExtensionVirtualModel<CouncilState>) => { definitions.set(model.id, model); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); } } as any);
	const states = new Map<string, CouncilState>();
	async function route(reason: "user" | "continuation" | "retry" | "direct" = "user", signal?: AbortSignal) {
		const id = ctx.model.id;
		const result = await definitions.get(id)!.route({ model: ctx.model, thinkingLevel: "medium", reason, messages, state: states.get(id), signal }, ctx);
		if (result.state) {
			states.set(id, result.state);
			branch.push({ type: "custom", customType: "pi.virtual-model-state",
				data: { provider: PROVIDER, modelId: id, state: result.state } });
		}
		return result;
	}
	return { ctx, branch, models, calls, statuses, handlers, definitions, get definition() { return definitions.get(ctx.model.id)!; }, route,
		get state() { return states.get(ctx.model.id); },
		setAnswer(fn: typeof answer) { answer = fn; }, get aborted() { return aborted; } };
}

test("registers Council and consults all three in parallel with exact efforts and priority", async () => {
	const h = harness();
	const releases: (() => void)[] = [];
	h.setAnswer(model => new Promise(resolve => releases.push(() => resolve(response(model)))));
	const pending = h.route();
	expect(h.calls).toHaveLength(3);
	expect(h.definition.id).toBe("council");
	expect(h.definition.thinkingLevels).toEqual(["medium"]);
	expect(h.calls.map(call => call.options.reasoning)).toEqual(["medium", "medium", "low"]);
	for (const call of h.calls) {
		expect(call.context.tools).toBeUndefined();
		expect(call.options.signal).toBeDefined();
		expect(call.options.maxTokens).toBe(4096);
		const payload = { model: call.model.id };
		const modified = await call.options.onPayload!(payload, call.model);
		expect(modified).toEqual(call.model.provider === "openai" ? { ...payload, service_tier: "priority" } : undefined);
	}
	releases.forEach(release => release());
	const result = await pending;
	expect(result.model.id).toBe("gpt-6.1-sol");
	expect(result.thinkingLevel).toBe("medium");
	expect(h.state?.advice).toHaveLength(3);
	expect(h.state?.advice[0].usage).toEqual(usage);
	const transformed = h.handlers.get("context_with_system")!({ messages }, h.ctx);
	expect(transformed.messages.at(-1).role).toBe("system");
	expect(transformed.messages.at(-1).content).toContain("Resolve disagreements");
	expect(transformed.messages.at(-1).content).toContain("claude-opus-5-5");
	expect(transformed.messages.at(-1).content).toContain("Do not quote advisor blocks");
	expect(transformed.messages.filter((message: Message) => message.role === "user")).toEqual(messages);
	expect(h.handlers.get("before_provider_request")!({ payload: { model: "gpt-6.1-sol" } }, h.ctx))
		.toEqual({ model: "gpt-6.1-sol", service_tier: "priority" });
});

test("Council OpenAI consults two high-effort priority advisors without Anthropic auth", async () => {
	const h = harness(OPENAI_MODEL_ID);
	h.ctx.modelRegistry.hasConfiguredAuth = (model: Model<any>) => model.provider === "openai";
	const releases: (() => void)[] = [];
	h.setAnswer(model => new Promise(resolve => releases.push(() => resolve(response(model)))));
	const pending = h.route();
	expect([...h.definitions.keys()]).toEqual([MODEL_ID, OPENAI_MODEL_ID]);
	expect(h.calls).toHaveLength(2);
	expect(h.calls.map(call => call.model.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
	expect(h.calls.map(call => call.options.reasoning)).toEqual(["high", "high"]);
	for (const call of h.calls) {
		expect(await call.options.onPayload!({ model: call.model.id }, call.model)).toEqual({ model: call.model.id, service_tier: "priority" });
	}
	releases.forEach(release => release());
	const result = await pending;
	expect(result.model.id).toBe("gpt-6.1-sol");
	expect(result.thinkingLevel).toBe("medium");
	expect(h.statuses).toContain("council-openai: consulting 0/2");
	expect(h.statuses).toContain("council-openai: consulting 2/2");
	const text = JSON.stringify(adviceMessage(h.state!));
	expect(text).toContain("Synthesize all 2 advisory answers");
	expect(text).not.toContain("claude");
	expect(h.handlers.get("before_provider_request")!({ payload: { model: result.model.id } }, h.ctx))
		.toEqual({ model: "gpt-6.1-sol", service_tier: "priority" });
});

test("switching variants keeps advice and execution slots separate on the same branch", async () => {
	const h = harness();
	await h.route();
	const originalState = h.state!;
	h.ctx.model.id = OPENAI_MODEL_ID;
	await h.route();
	expect(h.calls).toHaveLength(5);
	expect(h.state?.turns).toBe(1);
	expect(h.state?.advice).toHaveLength(2);
	let context = h.handlers.get("context_with_system")!({ messages }, h.ctx);
	expect(JSON.stringify(context.messages.at(-1))).toContain("Synthesize all 2 advisory answers");
	h.ctx.model.id = MODEL_ID;
	context = h.handlers.get("context_with_system")!({ messages }, h.ctx);
	expect(context.messages.at(-1)).toEqual(adviceMessage(originalState));
	await h.route("continuation");
	expect(h.calls).toHaveLength(5);
	expect(h.state?.turns).toBe(2);
	expect(h.state?.advice).toHaveLength(3);
	h.ctx.model.id = OPENAI_MODEL_ID;
	await h.route("direct");
	expect(h.calls).toHaveLength(5);
	expect(h.state?.turns).toBe(1);
	await h.route("retry");
	expect(h.state?.turns).toBe(1);
	expect(h.calls).toHaveLength(5);
});

test("Council OpenAI fails closed when either advisor fails", async () => {
	for (const id of ["gpt-6.1-sol", "gpt-6-astra"]) {
		const h = harness(OPENAI_MODEL_ID);
		h.setAnswer(model => Promise.resolve(response(model, model.id === id ? { stopReason: "error", errorMessage: "fixture failure" } : {})));
		await expect(h.route()).rejects.toThrow("Council advisor");
		expect(h.state).toBeUndefined();
		expect(h.calls.every(call => call.options.signal?.aborted)).toBe(true);
	}
});

function notification(kind = "message") {
	return { role: "custom", customType: "swarm-message", content: "Worker progress remains visible.",
		display: true, details: { kind }, timestamp: 1 };
}

test.each([MODEL_ID, OPENAI_MODEL_ID])("%s reuses internal advice for swarm notifications at the budget boundary", async modelId => {
	const h = harness(modelId);
	await h.route();
	for (let turn = 2; turn <= TURN_BUDGET; turn++) await h.route("continuation");
	const reserved = h.state;
	const callsBefore = h.calls.length;
	h.branch.push({ type: "message", id: "executor-last", message: response(h.models[0]) });
	const message = notification();
	h.branch.push({ type: "custom_message", id: "swarm-1", ...message });
	await h.route("user");
	expect(h.state).toBe(reserved);
	expect(h.state?.turns).toBe(TURN_BUDGET);
	expect(h.calls).toHaveLength(callsBefore);
	const leading = { role: "system", content: "Original system prompt", timestamp: 0 };
	const context = h.handlers.get("context_with_system")!({ messages: [leading, ...messages, message] }, h.ctx);
	expect(context.messages[0]).toBe(leading);
	expect(context.messages[2]).toBe(message);
	expect(context.messages.filter((entry: any) => entry.role === "user")).toEqual(messages);
	expect(context.messages.at(-1).role).toBe("system");
	expect(context.messages.at(-1).content).toContain("Keep advisor answers internal");
	expect(context.messages.at(-1).content).toContain("Do not resynthesize or restate");
	expect(context.messages.at(-1).content).toContain("not a live status report");
	expect(context.messages.at(-1).content).toContain("handoffs take precedence");
	expect(h.branch.filter(entry => entry.type === "message").some(entry => JSON.stringify(entry.message).includes("Advisor openai/"))).toBe(false);
	await h.route("retry");
	expect(h.calls).toHaveLength(callsBefore);
	expect(h.state).toBe(reserved);
	h.branch.push({ type: "message", id: "executor-notify", message: response(h.models[0]) });
	h.branch.push({ type: "custom_message", id: "swarm-2", ...notification() });
	await h.route("continuation");
	expect(h.calls).toHaveLength(callsBefore);
	expect(h.state).toBe(reserved);
	// A tool result means real work is continuing, even if a notification also arrived.
	h.branch.push({ type: "message", id: "tool-result", message: { role: "toolResult", toolName: "read", toolCallId: "read-1", content: [], isError: false, timestamp: 1 } });
	await h.route("continuation");
	expect(h.calls).toHaveLength(callsBefore * 2);
	expect(h.state?.round).toBe(2);
	expect(h.state?.turns).toBe(1);
});

test.each([MODEL_ID, OPENAI_MODEL_ID])("%s can handle a swarm notification before its first consultation, including retries", async modelId => {
	const h = harness(modelId);
	h.branch.length = 0;
	h.branch.push({ type: "custom_message", id: "swarm-initial", ...notification() });
	await h.route("user");
	expect(h.calls).toHaveLength(0);
	expect(h.state).toBeUndefined();
	expect(h.handlers.get("context_with_system")!({ messages: [notification()] }, h.ctx)).toBeUndefined();
	expect(h.aborted).toBe(false);
	h.branch.push({ type: "message", id: "failed-notification", message: response(h.models[0], { stopReason: "error" }) });
	await h.route("retry");
	expect(h.calls).toHaveLength(0);
	expect(h.state).toBeUndefined();
});

test.each([MODEL_ID, OPENAI_MODEL_ID])("%s still consults for real user work or parent instructions", async modelId => {
	for (const nextMessage of [messages[0], notification("instruction")]) {
		const h = harness(modelId);
		await h.route();
		for (let turn = 2; turn <= TURN_BUDGET; turn++) await h.route("continuation");
		const count = h.calls.length;
		h.branch.push({ type: "message", id: "executor-last", message: response(h.models[0]) });
		h.branch.push({ type: "custom_message", id: "swarm-status", ...notification() });
		h.branch.push(nextMessage.role === "custom" ? { type: "custom_message", id: "new-work", ...nextMessage }
			: { type: "message", id: "new-work", message: nextMessage });
		await h.route("user");
		expect(h.calls).toHaveLength(count * 2);
		expect(h.state?.turns).toBe(1);
	}
});

test("known swarm notices reuse advice, but unrelated extension messages remain normal work", async () => {
	const h = harness();
	await h.route();
	for (let turn = 2; turn <= TURN_BUDGET; turn++) await h.route("continuation");
	const state = h.state;
	h.branch.push({ type: "message", id: "last-response", message: response(h.models[0]) });
	for (const customType of ["swarm-health-alert", "swarm-worker-checkin", "swarm-review-reminder", "swarm-handoff", "swarm-error-resume"]) {
		h.branch.push({ type: "custom_message", id: customType, customType, content: "Notification", display: true });
		await h.route("continuation");
		expect(h.state).toBe(state);
		expect(h.calls).toHaveLength(3);
	}
	h.branch.push({ type: "custom_message", id: "other", customType: "other-extension", content: "Continue work", display: false });
	await h.route("continuation");
	expect(h.calls).toHaveLength(6);
	expect(h.state?.turns).toBe(1);
});

test("reconsults only at the ninth response and reuses retries", async () => {
	const h = harness();
	await h.route();
	for (let turn = 2; turn <= TURN_BUDGET; turn++) {
		await h.route("continuation");
		expect(h.state?.turns).toBe(turn);
	}
	expect(h.calls).toHaveLength(3);
	const reserved = h.state;
	await h.route("retry");
	expect(h.state).toBe(reserved);
	expect(h.calls).toHaveLength(3);
	await h.route("continuation");
	expect(h.calls).toHaveLength(6);
	expect(h.state?.turns).toBe(1);
	expect(h.state?.round).toBe(2);
	h.branch.push({ type: "message", id: "task-2", message: messages[0] });
	await h.route("user");
	expect(h.calls).toHaveLength(9);
	expect(h.state?.taskId).toBe("task-2");
});

test("direct requests do not consult or spend the budget; non-Council events are unchanged", async () => {
	const h = harness();
	await h.route("direct");
	expect(h.calls).toHaveLength(0);
	expect(h.state).toBeUndefined();
	expect(h.handlers.get("before_provider_request")!({ payload: { model: "claude-opus-5-5" } }, h.ctx)).toBeUndefined();
	h.ctx.model = { provider: "anthropic", id: "claude-opus-5-5" };
	expect(h.handlers.get("context_with_system")!({ messages }, h.ctx)).toBeUndefined();
	expect(h.handlers.get("before_provider_request")!({ payload: { model: "gpt-6.1-sol" } }, h.ctx)).toBeUndefined();
});

test.each(["error", "aborted", "length", "toolUse"] as const)("advisor %s prevents executor dispatch", async stopReason => {
	const h = harness();
	h.setAnswer(model => Promise.resolve(response(model, { stopReason, errorMessage: "fixture failure" })));
	await expect(h.route()).rejects.toThrow("Council advisor");
	expect(h.state).toBeUndefined();
	expect(h.calls.every(call => call.options.signal?.aborted)).toBe(true);
});

test("empty advice, tool calls, missing auth and cancellation fail closed", async () => {
	for (const content of [[], [{ type: "toolCall", id: "x", name: "bash", arguments: {} }]] as AssistantMessage["content"][]) {
		const h = harness();
		h.setAnswer(model => Promise.resolve(response(model, { content })));
		await expect(h.route()).rejects.toThrow("Council advisor");
		expect(h.state).toBeUndefined();
	}
	const missing = harness();
	missing.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await expect(missing.route()).rejects.toThrow("Council requires gpt-6.1-sol");
	expect(missing.calls).toHaveLength(0);
	const missingOpus = harness();
	missingOpus.ctx.modelRegistry.hasConfiguredAuth = (model: Model<any>) => model.provider !== "anthropic";
	await expect(missingOpus.route()).rejects.toThrow("Council requires claude-opus-5-5");
	expect(missingOpus.calls).toHaveLength(0);
	const cancelled = harness();
	await expect(cancelled.route("user", AbortSignal.abort())).rejects.toThrow("Council advisor");
	expect(cancelled.state).toBeUndefined();
	const noAdvice = harness();
	expect(() => noAdvice.handlers.get("context_with_system")!({ messages }, noAdvice.ctx)).toThrow("successful consultation");
	expect(noAdvice.aborted).toBe(true);
});

test("context handles strings, marks truncation and images, and omits private thinking", () => {
	const model = harness().models[0];
	const text = advisorContext([
		{ role: "system", content: "system", timestamp: 0 },
		{ role: "user", content: "x".repeat(130_000), timestamp: 1 },
		response(model, { content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "visible" }] }),
		{ role: "user", content: [{ type: "image", data: "private-image", mimeType: "image/png" }], timestamp: 2 },
	]);
	expect(text).toStartWith("[Earlier context omitted.]");
	expect(text).toContain("visible");
	expect(text).toContain("Image attached");
	expect(text).not.toContain("secret");
	expect(text).not.toContain("private-image");
});

test.each([MODEL_ID, OPENAI_MODEL_ID])("%s uses exact Codex models when OpenAI auth is unavailable", async modelId => {
	const h = harness(modelId);
	for (const model of h.models) if (model.provider === "openai") model.provider = "openai-codex";
	const result = await h.route();
	expect(result.model.provider).toBe("openai-codex");
	expect(h.calls.map(call => call.model.provider)).toEqual(modelId === OPENAI_MODEL_ID
		? ["openai-codex", "openai-codex"] : ["openai-codex", "openai-codex", "anthropic"]);
	for (const call of h.calls.filter(call => call.model.provider === "openai-codex")) {
		expect(await call.options.onPayload!({ model: call.model.id }, call.model)).toEqual({ model: call.model.id, service_tier: "priority" });
	}
});

test("reports the original advisor failure rather than a sibling cancellation", async () => {
	const h = harness();
	h.setAnswer(model => {
		if (model.id === "claude-opus-5-5") return Promise.reject(new Error("Original Opus failure"));
		const call = h.calls.find(call => call.model === model)!;
		return new Promise((_resolve, reject) => call.options.signal!.addEventListener("abort", () => reject(new Error("Sibling cancelled")), { once: true }));
	});
	await expect(h.route()).rejects.toThrow("Council advisor claude-opus-5-5 failed: Original Opus failure");
});

test("context restores advice from branch state without retaining another branch in memory", async () => {
	const h = harness();
	await h.route();
	const state = h.state!;
	h.branch.length = 1;
	expect(() => h.handlers.get("context_with_system")!({ messages }, h.ctx)).toThrow();
	h.branch.push({ type: "custom", customType: "pi.virtual-model-state",
		data: { provider: PROVIDER, modelId: MODEL_ID, state: JSON.parse(JSON.stringify(state)) } });
	expect(h.handlers.get("context_with_system")!({ messages }, h.ctx).messages.at(-1)).toEqual(adviceMessage(state));
});
