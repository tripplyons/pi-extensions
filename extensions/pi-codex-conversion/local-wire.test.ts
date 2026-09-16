import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { createLocalContext, localNotes } from "./local-context.ts";
import { HistoryParameters, NotesParameters } from "./local-context-tools.ts";
import { codexLocalLaneId, LOCAL_CODEX_CONFIG, localCodexStream, releaseLocalCodexLanes } from "./local-codex-provider.ts";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.test`;
const context = { messages: [{ role: "user" as const, content: "local sentinel", timestamp: 1 }], tools: [] };
function fixture(events?: unknown[]) {
	const requests: { body: Record<string, any>; headers: Headers; path: string }[] = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const bytes = new Uint8Array(await request.arrayBuffer());
		const body = request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes;
		requests.push({ body: JSON.parse(new TextDecoder().decode(body)), headers: request.headers, path: new URL(request.url).pathname });
		return new Response(events ? events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") : 'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":7,"output_tokens":0}}}\n\n', {
			headers: { "content-type": "text/event-stream", "x-codex-turn-state": "remote-state-must-not-return" },
		});
	};
	const model: Model<"openai-codex-responses"> = {
		provider: "openai-codex", id: "gpt-5.4", name: "fixture", api: "openai-codex-responses",
		baseUrl: "https://fixture.invalid", reasoning: true, input: ["text"],
		contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		headers: { "X-Codex-Beta-Features": "remote_compaction_v2", "X-Codex-Window-Id": "root" },
	};
	return { requests, model, close: () => { globalThis.fetch = previousFetch; } };
}

test("native namespace tool responses round-trip through local notes and full-input replay", async () => {
	const args = { path: "facts", text: "namespace-note-sentinel" };
	const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", namespace: "notes", name: "write_file", arguments: JSON.stringify(args) };
	const h = fixture([
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 7, output_tokens: 4 } } },
	]);
	const tools = [
		{ name: "history", description: "Local history", parameters: HistoryParameters },
		{ name: "notes", description: "Local notes", parameters: NotesParameters },
	];
	try {
		const message = await localCodexStream(h.model, { ...context, tools }, { apiKey: token, sessionId: "namespace-fixture", maxRetries: 0 }).result();
		expect(message.stopReason).toBe("toolUse");
		const call = message.content.find(block => block.type === "toolCall")!;
		expect(call).toMatchObject({ name: "notes", namespace: "notes", arguments: { action: "write_file", ...args } });
		const state = createLocalContext({ branchId: "fixture", preset: "fixture", role: "writer" });
		const result = localNotes(state, "write_file", call.arguments);
		expect(state.notes[0].text).toBe("namespace-note-sentinel");
		await localCodexStream(h.model, { ...context, tools, messages: [...context.messages, message, {
			role: "toolResult", toolCallId: call.id, toolName: "notes", content: [{ type: "text", text: JSON.stringify(result) }], isError: false, timestamp: 2,
		}] }, { apiKey: token, sessionId: "namespace-fixture", maxRetries: 0 }).result();
		const body = h.requests[1].body;
		expect(body.input).toContainEqual(expect.objectContaining({ type: "function_call", name: "write_file", namespace: "notes" }));
		expect(body.input).toContainEqual(expect.objectContaining({ type: "function_call_output" }));
		expect(body.previous_response_id).toBeUndefined();
	} finally { h.close(); }
});

test("transport policy is frozen and disables upstream context and cache state", () => {
	expect(Object.isFrozen(LOCAL_CODEX_CONFIG)).toBe(true);
	expect(Object.isFrozen(LOCAL_CODEX_CONFIG.compaction)).toBe(true);
	expect(Object.isFrozen(LOCAL_CODEX_CONFIG.openai)).toBe(true);
	expect(LOCAL_CODEX_CONFIG.compaction).toMatchObject({ contextManagement: "off", hybridCompaction: false, responsesCompaction: false });
	expect(LOCAL_CODEX_CONFIG.openai).toMatchObject({ forceCachedWebSockets: false, proxyResponsesLite: false, cacheKeepalive: false, cacheDiagnostics: "off" });
});

test("final SSE wire keeps full input and consistent opaque correlation on successive requests", async () => {
	const h = fixture();
	let payloadCalls = 0;
	let responseCalls = 0;
	try {
		for (let turn = 0; turn < 2; turn++) {
			const result = await localCodexStream(h.model, context, {
				apiKey: token, sessionId: "root/mixture/run/writer", transport: "websocket", maxRetries: 0,
				serviceTier: "priority", reasoning: "high", textVerbosity: "high",
				headers: { "X-CODEX-Turn-State": "remote", "X-Codex-Turn-Metadata": "root", "x-fixture": "kept" },
				onPayload: body => { payloadCalls++; body.custom_field = "kept"; return undefined; },
				onResponse: response => { responseCalls++; expect(response.status).toBe(200); },
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.usage.input).toBe(7);
		}
		expect(payloadCalls).toBe(2);
		expect(responseCalls).toBe(2);
		expect(h.requests).toHaveLength(2);
		for (const { body, headers, path } of h.requests) {
			expect(path).toBe("/codex/responses");
			expect(JSON.stringify(body.input)).toContain("local sentinel");
			expect(body.custom_field).toBe("kept");
			expect(body.service_tier).toBe("priority");
			expect(body.reasoning.effort).toBe("high");
			expect(body.text.verbosity).toBe("high");
			expect(body.previous_response_id).toBeUndefined();
			expect(body.compaction_trigger).toBeUndefined();
			const lane = codexLocalLaneId("root/mixture/run/writer");
			expect(body.prompt_cache_key).toBe(lane);
			expect(body.client_metadata.session_id).toBe(lane);
			expect(body.client_metadata.thread_id).toBe(lane);
			for (const name of ["session-id", "thread-id", "x-client-request-id"]) expect(headers.get(name)).toBe(lane);
			for (const name of ["x-codex-beta-features", "x-codex-turn-state", "x-codex-window-id", "x-codex-turn-metadata", "x-openai-internal-codex-responses-lite"]) expect(headers.has(name)).toBe(false);
			expect(headers.get("authorization")).toBe(`Bearer ${token}`);
			expect(headers.get("x-fixture")).toBe("kept");
			expect(headers.get("accept")).toBe("text/event-stream");
		}
	} finally { h.close(); }
});

test("releasing an acquired lane cancels only its request", async () => {
	const h = fixture();
	const ready = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	try {
		const cancelled = localCodexStream(h.model, context, {
			apiKey: token, sessionId: "cancel-this-lane", maxRetries: 0,
			onPayload: async () => { ready.resolve(); await resume.promise; },
		});
		await ready.promise;
		releaseLocalCodexLanes(["cancel-this-lane"]);
		releaseLocalCodexLanes(["cancel-this-lane"]);
		resume.resolve();
		expect((await cancelled.result()).stopReason).toBe("aborted");
		expect(h.requests).toHaveLength(0);
		const unrelated = await localCodexStream(h.model, context, { apiKey: token, sessionId: "keep-this-lane", maxRetries: 0 }).result();
		expect(unrelated.stopReason).toBe("stop");
		expect(h.requests).toHaveLength(1);
	} finally { resume.resolve(); h.close(); }
});

test("callback-injected remote state and incompatible policy fail before HTTP", async () => {
	const h = fixture();
	try {
		for (const field of ["previous_response_id", "context_management", "compaction_trigger"]) {
			const result = await localCodexStream(h.model, context, {
				apiKey: token, maxRetries: 0, onPayload: body => ({ ...body, [field]: "remote" }),
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("prohibited");
		}
		for (const input of [
			[{ type: "compaction", encrypted_content: "opaque-remote-state" }],
			[{ type: "item_reference", id: "remote-item" }],
			[{ type: "function_call", call_id: "", name: "discarded-call", arguments: "{}", previous_response_id: "must-not-be-normalized-away" }],
		]) {
			const rejected = await localCodexStream(h.model, context, { apiKey: token, maxRetries: 0, onPayload: body => ({ ...body, input }) }).result();
			expect(rejected.stopReason).toBe("error");
			expect(rejected.errorMessage).toContain("prohibited");
		}
		let payloadCalls = 0;
		const result = await localCodexStream(h.model, context, {
			apiKey: token, onPayload: () => { payloadCalls++; },
		}, () => { throw new Error("incompatible policy"); }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("incompatible policy");
		expect(payloadCalls).toBe(0);
		expect(h.requests).toHaveLength(0);
	} finally { h.close(); }
});
