import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { defaultConfig } from "./config.ts";
import { abortable, callRole, createMixtureProvider, emitMessage, emptyUsage, modelDefinition, validatePreset, type Registry } from "./provider.ts";

export const model = (provider = "test", id = "lead"): Model<any> => ({
	provider, id, api: "test-api", name: id, baseUrl: "https://test.invalid", reasoning: true,
	input: ["text", "image"], contextWindow: 100_000, maxTokens: 20_000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
});
const message = (): AssistantMessage => ({ role: "assistant", provider: "test", model: "lead", api: "test-api",
	content: [{ type: "text", text: "hello" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "test.txt" } }],
	usage: { ...emptyUsage(), input: 10, output: 5, totalTokens: 15 }, timestamp: 1, stopReason: "toolUse" });

test("native provider has ambient role auth and conservative catalog metadata", async () => {
	const config = defaultConfig();
	const find = (provider: string, id: string) => model(provider, id);
	const provider = createMixtureProvider(config, find, () => createAssistantMessageEventStream());
	expect(provider.getModels()[0].provider).toBe("mixture");
	expect(provider.getModels()[0].id).toBe("default");
	expect(provider.getModels()[0].maxTokens).toBe(16_384);
	expect(await provider.auth.apiKey!.resolve({} as any)).toEqual({ auth: {}, source: "Mixture role providers" });
	const preset = config.presets.default;
	expect(modelDefinition("default", preset, (p, id) => ({ ...model(p, id), input: id.includes("meta") ? ["text"] : ["text", "image"] })).input).toEqual(["text", "image"]);
	expect(() => validatePreset(preset, (p, id) => ({ ...model(p, id), thinkingLevelMap: { low: null } }))).toThrow("does not support");
});
test("emits native text and structured tool events with one terminal result", async () => {
	const stream = createAssistantMessageEventStream();
	emitMessage(stream, message());
	const events = [];
	for await (const event of stream) events.push(event);
	expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
	expect(await stream.result()).toEqual(message());
});
test("role calls use effective provider auth, endpoint, callbacks and thinking", async () => {
	let seen: { model: Model<any>; options: SimpleStreamOptions } | undefined;
	const registry: Registry = {
		find: () => model("openai-codex"),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "role-secret", headers: { "x-role": "yes" }, env: { REGION: "local" }, baseUrl: "https://role.invalid" }),
		getProvider: () => ({ streamSimple: (model, _context, options) => {
			seen = { model, options: options! };
			const stream = createAssistantMessageEventStream(); emitMessage(stream, message()); return stream;
		} }) as any,
	};
	const callback = () => {};
	const result = await callRole(registry, "test/lead", { messages: [] }, "high", {
		timeoutMs: 1000, maxTokens: 999_999, serviceTier: "priority", apiKey: "composite-secret", headers: { authorization: "wrong" }, env: { WRONG: "wrong" }, onPayload: callback,
	});
	expect(result.stopReason).toBe("toolUse");
	expect(seen?.model.baseUrl).toBe("https://role.invalid");
	expect(seen?.options).toMatchObject({ apiKey: "role-secret", headers: { "x-role": "yes" }, env: { REGION: "local" }, reasoning: "high", serviceTier: "priority", maxTokens: 20_000, maxRetries: 0 });
	expect(seen?.options.onPayload).toBe(callback);
});
test("writer idle deadlines reset on stream activity but remain absolutely bounded", async () => {
	let completedSignal: AbortSignal | undefined;
	const activeRegistry: Registry = {
		find: () => model(), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (_model, _context, options) => {
			completedSignal = options?.signal;
			return (async function* () {
				const partial = { ...message(), content: [], stopReason: "pending" as const };
				yield { type: "start", partial };
				for (let index = 0; index < 4; index++) { await Bun.sleep(12); yield { type: "text_delta", contentIndex: 0, delta: "x", partial }; }
				yield { type: "done", reason: "stop", message: { ...message(), content: [{ type: "text", text: "complete" }], stopReason: "stop" } };
			})() as any;
		} }) as any,
	};
	const active = await callRole(activeRegistry, "test/lead", { messages: [] }, "high", { timeoutMs: 200, idleTimeoutMs: 25 });
	expect(active.stopReason).toBe("stop");
	await Bun.sleep(35);
	expect(completedSignal?.aborted).toBe(false);

	const stalledRegistry: Registry = {
		find: () => model(), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: () => (async function* () {
			const partial = { ...message(), content: [], stopReason: "pending" as const };
			yield { type: "start", partial };
			await Bun.sleep(80);
			yield { type: "done", reason: "stop", message: message() };
		})() as any }) as any,
	};
	const stalled = await callRole(stalledRegistry, "test/lead", { messages: [] }, "high", { timeoutMs: 200, idleTimeoutMs: 20 });
	expect(stalled.stopReason).toBe("error");
	expect(stalled.errorMessage).toContain("provider idle timeout");

	const boundedRegistry: Registry = {
		find: () => model(), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (_model, _context, options) => (async function* () {
			const partial = { ...message(), content: [], stopReason: "pending" as const };
			while (!options?.signal?.aborted) { await Bun.sleep(10); yield { type: "text_delta", contentIndex: 0, delta: "x", partial }; }
		})() as any }) as any,
	};
	const bounded = await callRole(boundedRegistry, "test/lead", { messages: [] }, "high", { timeoutMs: 45, idleTimeoutMs: 25 });
	expect(bounded.stopReason).toBe("error");
	expect(bounded.errorMessage).not.toContain("provider idle timeout");
});

test("timeout bounds auth and never dispatches after cancellation", async () => {
	let calls = 0;
	const registry: Registry = {
		find: () => model(), getApiKeyAndHeaders: () => new Promise(() => {}),
		getProvider: () => ({ streamSimple: () => { calls++; } }) as any,
	};
	const controller = new AbortController();
	const result = callRole(registry, "test/lead", { messages: [] }, "high", { timeoutMs: 1000, signal: controller.signal });
	controller.abort();
	expect((await result).stopReason).toBe("aborted");
	expect(calls).toBe(0);
	await expect(abortable(Promise.resolve(1), controller.signal)).rejects.toThrow();
});
