import { expect, test } from "bun:test";
import type { Provider } from "@earendil-works/pi-ai";
import {
	assertLocalCodexBody,
	codexLocalLaneId,
	prepareLocalCodexRequestBody,
	sanitizeCodexHeaders,
	sanitizeNativeCodexPayload,
	wrapLocalCodexProvider,
} from "./local-codex-provider.ts";

test("local Codex lanes are opaque and stable", () => {
	const first = codexLocalLaneId("root/mixture/run/writer");
	expect(first).toBe(codexLocalLaneId("root/mixture/run/writer"));
	expect(first).not.toContain("root");
	expect(first).not.toBe(codexLocalLaneId("root/mixture/run/lead"));
});

test("prohibited headers are removed without regard to case", () => {
	const headers = sanitizeCodexHeaders({
		"X-Codex-Beta-Features": "remote_compaction_v2",
		"x-CODEX-turn-state": "state",
		"X-OpenAI-Internal-Codex-Responses-Lite": "true",
		"x-client-request-id": "allowed",
	});
	expect(headers).toEqual({ "x-client-request-id": "allowed" });
});

test("prohibited body state is rejected rather than stripped", () => {
	for (const body of [
		{ previous_response_id: "remote" },
		{ input: [{ type: "compaction_trigger" }] },
		{ input: [{ type: "additional_tools" }] },
		{ client_metadata: { "X-Codex-Turn-Metadata": "remote" } },
		{ reasoning: { context: "all_turns" } },
	]) expect(() => assertLocalCodexBody(body)).toThrow("prohibited");
});

test("the prepared request uses local correlation and preserves ordinary callback fields", async () => {
	const model = { provider: "openai-codex", id: "gpt", name: "gpt", api: "openai-codex-responses", baseUrl: "https://example.test", reasoning: true, input: ["text"], contextWindow: 10_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any;
	let callbackBody: any;
	const body = await prepareLocalCodexRequestBody(model, { systemPrompt: "rules", messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] }, {
		sessionId: "root/mixture/run/writer",
		onPayload: async value => { callbackBody = value; return { ...value, custom_field: "kept" }; },
	});
	expect(callbackBody).toBeDefined();
	expect(body.custom_field).toBe("kept");
	expect(body.prompt_cache_key).toBe(codexLocalLaneId("root/mixture/run/writer"));
	expect(body.client_metadata?.session_id).toBe(body.prompt_cache_key);
	expect(body.client_metadata?.thread_id).toBe(body.prompt_cache_key);
});

test("the native callback adapter removes only native-generated context state", () => {
	const original = {
		model: "gpt",
		instructions: "keep this",
		input: [{ type: "message", role: "user", content: "hello" }],
		tools: [{ type: "function", name: "history" }],
	};
	const generated = {
		...original,
		previous_response_id: "remote",
		input: [{ type: "compaction_trigger" }, ...original.input],
		client_metadata: { context_window_id: "remote" },
	};
	const sanitized = sanitizeNativeCodexPayload(original, generated) as any;
	expect(sanitized.previous_response_id).toBeUndefined();
	expect(sanitized.input).toEqual(original.input);
	expect(sanitized.client_metadata).toBeUndefined();
	const explicit = sanitizeNativeCodexPayload({ ...original, input: [{ type: "compaction_trigger" }] }, generated) as any;
	expect(explicit.input).toContainEqual({ type: "compaction_trigger" });
});

test("provider wrapping preserves non-Codex providers and metadata", () => {
	const ordinary = { id: "ordinary", name: "Ordinary", auth: {}, getModels: () => [], stream: () => "stream", streamSimple: () => "simple", marker: true } as unknown as Provider;
	expect(wrapLocalCodexProvider(ordinary)).toBe(ordinary);
	const codex = { id: "openai-codex", name: "Codex", auth: {}, getModels: () => [], stream: () => "stream", streamSimple: () => "simple", marker: true } as unknown as Provider;
	const wrapped = wrapLocalCodexProvider(codex);
	expect(wrapped).toMatchObject({ id: "openai-codex", name: "Codex", marker: true });
	expect(wrapped.streamSimple).not.toBe(codex.streamSimple);
});
