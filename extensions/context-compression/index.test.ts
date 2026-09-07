import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { SessionManager as SessionManagerType, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { BLOCK_TYPE, HINT_TYPE, KEEP_RECENT, PAGE_CHARS, readBlocks, readEnabled, projectContext, selectRange, originalText, messageText } from "./core.ts";

const piExecutable = Bun.which("pi");
if (!piExecutable) throw new Error("pi is required to test context compression");
const piCli = realpathSync(piExecutable);
const dependencies = resolve(dirname(piCli), "../../node_modules");
const sessionCore = await import(resolve(dirname(piCli), "../core/session-manager.js"));
const messageCore = await import(resolve(dirname(piCli), "../core/messages.js"));
const { SessionManager } = sessionCore;
mock.module("@earendil-works/pi-coding-agent", () => ({ ...sessionCore, ...messageCore }));
const ai = await import(resolve(dependencies, "@earendil-works/pi-ai/dist/index.js"));
mock.module("@earendil-works/pi-ai", () => ai);
const typebox = await import(resolve(dependencies, "typebox/build/index.mjs"));
mock.module("typebox", () => typebox);
const { default: extension } = await import("./index.ts");
const { effectiveInputForBranch, NATIVE_COMPACTION_KIND, modelKey } = await import("../codex-compaction/native-compaction.ts");

const model: Model<"openai-codex-responses"> = {
	id: "test", name: "test", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "http://localhost",
	reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096,
};
let time = 1;
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant", content, timestamp: time++, provider: model.provider, api: model.api, model: model.id,
	stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: time++ });
const prose = (text: string) => assistant([{ type: "text", text }]);
const toolCall = (id: string, name = "read") => ({ type: "toolCall" as const, id, name, arguments: { path: "auth.ts" } });
const toolResult = (id: string, text: string, name = "read"): AgentMessage => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: time++ });
const original = "exact failure: TOKEN_EXPIRED in auth.ts\n".repeat(400);
const on = { enabled: true, pressure: false };

function seed(sm = SessionManager.inMemory()) {
	sm.appendMessage(user("Keep public APIs unchanged."));
	const start = sm.appendMessage(assistant([toolCall("read-auth")]));
	const end = sm.appendMessage(toolResult("read-auth", original));
	sm.appendMessage(prose("We fixed expiry handling. ".repeat(50)));
	for (let i = 0; i < KEEP_RECENT; i++) sm.appendMessage(i % 2 ? prose(`Recent reply ${i}`) : user(`Recent request ${i}`));
	return { sm, start, end };
}

type Handler = (event: any, ctx: ExtensionContext) => any;
function harness(sm: SessionManagerType) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Handler>();
	const tools = new Map<string, ToolDefinition>();
	const statuses = new Map<string, string>();
	let percent = 10;
	const ctx = {
		sessionManager: sm, hasUI: true, model,
		getContextUsage: () => ({ percent, tokens: percent * 1000, contextWindow: 100_000 }),
		ui: { setStatus: (key: string, value?: string) => value ? statuses.set(key, value) : statuses.delete(key), theme: { fg: (_: string, text: string) => text }, notify() {} },
	} as unknown as ExtensionContext;
	extension({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command.handler),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data),
	} as unknown as ExtensionAPI);
	const fire = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	const request = () => {
		const messages = sm.buildSessionContext().messages;
		return fire("context", { messages: structuredClone(messages) })?.messages ?? messages;
	};
	return {
		ctx, statuses, fire, request, pressure: (value: number) => { percent = value; },
		command: (args: string) => commands.get("compression")!(args, ctx),
		call: (name: string, args: Record<string, unknown>) => tools.get(name)!.execute("test-call", args, undefined, undefined, ctx),
	};
}

describe("selective compression", () => {
	test("appends guidance to the existing system prompt only while enabled", async () => {
		const h = harness(SessionManager.inMemory());
		const event = { systemPrompt: "Keep existing instructions." };
		expect(h.fire("before_agent_start", event)).toBeUndefined();
		await h.command("on");
		const { systemPrompt } = h.fire("before_agent_start", event);
		expect(systemPrompt.startsWith(`${event.systemPrompt}\n\n`)).toBe(true);
		expect(systemPrompt.length).toBeGreaterThan(event.systemPrompt.length + 2);
		expect(event.systemPrompt).toBe("Keep existing instructions.");
		h.pressure(90);
		h.request();
		expect(h.fire("before_agent_start", event).systemPrompt).toBe(systemPrompt);
		await h.command("on");
		expect(h.fire("before_agent_start", event).systemPrompt).toBe(systemPrompt);
		await h.command("off");
		expect(h.fire("before_agent_start", event)).toBeUndefined();
	});

	test("defaults off, persists the toggle, rewrites the next request, and restores originals when off", async () => {
		const { sm, start, end } = seed();
		const h = harness(sm);
		h.fire("session_start");
		expect(h.statuses.size).toBe(0);
		expect(JSON.stringify(h.request())).not.toContain("context-ref");
		await expect(h.call("compress", { startId: start, endId: end, summary: "Fixed expiry." })).rejects.toThrow("off");
		await h.command("on");
		expect(h.statuses.get("context-compression")).toBe("compression on");
		expect(JSON.stringify(h.request())).toContain(`[context-ref ${start}]`);
		await h.call("compress", { startId: start, endId: end, summary: "Fixed token expiry in auth.ts; keep public APIs unchanged." });
		const rewritten = h.request();
		expect(JSON.stringify(rewritten)).not.toContain(original);
		expect(JSON.stringify(rewritten)).toContain("Fixed token expiry in auth.ts");
		expect(rewritten.filter((m: AgentMessage) => m.role === "toolResult")).toHaveLength(0);
		expect(sm.buildSessionContext().messages.some((m) => JSON.stringify(m).includes("TOKEN_EXPIRED"))).toBe(true);
		const resumed = harness(sm);
		resumed.fire("session_start");
		expect(resumed.statuses.get("context-compression")).toBe("compression on");
		expect(resumed.request()).toEqual(rewritten);
		await resumed.command("off");
		expect(resumed.statuses.size).toBe(0);
		expect(resumed.request()).toEqual(sm.buildSessionContext().messages);
		await resumed.command("");
		expect(readEnabled(sm.getEntries())).toBe(true);
		await resumed.command("invalid");
		expect(readEnabled(sm.getEntries())).toBe(true);
	});

	test("restores the toggle and summaries from a reopened session file", async () => {
		const dir = mkdtempSync(resolve(tmpdir(), "pi-compression-resume-"));
		try {
			const { sm, start, end } = seed(SessionManager.create(dir, dir));
			const h = harness(sm); await h.command("on"); h.request();
			await h.call("compress", { startId: start, endId: end, summary: "Expiry fixed." });
			const restored = harness(SessionManager.open(sm.getSessionFile()!));
			restored.fire("session_start");
			expect(restored.statuses.get("context-compression")).toBe("compression on");
			expect(restored.request()).toEqual(h.request());
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	test("retrieves paginated exact originals and searches original text", async () => {
		const { sm, start, end } = seed();
		const h = harness(sm);
		await h.command("on"); h.request();
		await h.call("compress", { startId: start, endId: end, summary: "Expiry fixed." });
		const block = readBlocks(sm.getBranch())[0]!;
		const first = await h.call("decompress", { blockId: block.id });
		expect(first.content[0]).toMatchObject({ text: expect.stringContaining(`Next offset: ${PAGE_CHARS}`) });
		const second = await h.call("decompress", { blockId: block.id, offset: PAGE_CHARS });
		expect(second.content[0]).toMatchObject({ text: expect.stringContaining(originalText(block, sm.getBranch()).slice(PAGE_CHARS, PAGE_CHARS * 2)) });
		const search = await h.call("search_context", { query: "token_expired" });
		expect(search.content[0]).toMatchObject({ text: expect.stringContaining(block.id) });
		expect((await h.call("search_context", { query: "not found" })).content[0]).toMatchObject({ text: "0 matching blocks." });
		await expect(h.call("decompress", { blockId: "missing" })).rejects.toThrow("No compressed block");
		expect(JSON.stringify(h.request())).not.toContain(original);
	});

	test("keeps user messages inside a range, recent work, and tool pairs", () => {
		const sm = SessionManager.inMemory();
		const start = sm.appendMessage(prose(original));
		sm.appendMessage(user("Never delete the database."));
		const end = sm.appendMessage(prose(original));
		for (let i = 0; i < KEEP_RECENT; i++) sm.appendMessage(user(`Recent ${i}`));
		const view = projectContext(sm.buildSessionContext().messages, sm.getBranch(), on);
		const refs = selectRange(view, start, end, sm.getBranch());
		expect(refs.map((ref) => ref.id)).toEqual([start, end]);
		sm.appendCustomEntry(BLOCK_TYPE, { version: 1, ids: [start, end], summary: "History summary" });
		const output = projectContext(sm.buildSessionContext().messages, sm.getBranch(), on).messages;
		expect(JSON.stringify(output)).toContain("Never delete the database.");
		expect(messageText(output[0]!)).toContain("[Compressed history");
		expect(output.slice(2, 2 + KEEP_RECENT)).toEqual(sm.buildSessionContext().messages.slice(-KEEP_RECENT));
	});

	test("rejects split groups, unknown refs, overlap, and summaries that do not save space", async () => {
		const { sm, start, end } = seed();
		const h = harness(sm); await h.command("on"); h.request();
		await expect(h.call("compress", { startId: end, endId: end, summary: "x" })).rejects.toThrow("splits");
		await expect(h.call("compress", { startId: start, endId: start, summary: "x" })).rejects.toThrow("splits");
		await expect(h.call("compress", { startId: "unknown", endId: end, summary: "x" })).rejects.toThrow("boundaries");
		await expect(h.call("compress", { startId: start, endId: end, summary: original })).rejects.toThrow("shorter");
		await h.call("compress", { startId: start, endId: end, summary: "Expiry fixed." });
		await expect(h.call("compress", { startId: start, endId: end, summary: "Again." })).rejects.toThrow("already compressed");
	});

	test("protects an entire multi-call group when a result is recent or contains an image", () => {
		for (const image of [false, true]) {
			const sm = SessionManager.inMemory();
			sm.appendMessage(assistant([toolCall("a"), toolCall("b")]));
			sm.appendMessage(toolResult("a", original));
			if (!image) for (let i = 0; i < KEEP_RECENT; i++) sm.appendMessage(user(`Recent ${i}`));
			const result = toolResult("b", original);
			if (image && result.role === "toolResult") result.content.push({ type: "image", data: "abc", mimeType: "image/png" });
			sm.appendMessage(result);
			if (image) for (let i = 0; i < KEEP_RECENT; i++) sm.appendMessage(user(`Recent ${i}`));
			const view = projectContext(sm.buildSessionContext().messages, sm.getBranch(), on);
			expect(view.refs.some((ref) => ref.eligible)).toBe(false);
		}
	});

	test("branch navigation does not leak blocks; toggle follows fast-mode session semantics", async () => {
		const { sm, start, end } = seed();
		const leaf = sm.getLeafId()!;
		const h = harness(sm); await h.command("on"); h.request();
		await h.call("compress", { startId: start, endId: end, summary: "Expiry fixed." });
		const block = readBlocks(sm.getBranch())[0]!;
		sm.branch(leaf); h.fire("session_tree");
		expect(readEnabled(sm.getEntries())).toBe(true);
		expect(JSON.stringify(h.request())).toContain("TOKEN_EXPIRED");
		await expect(h.call("decompress", { blockId: block.id })).rejects.toThrow("on this branch");
	});

	test("compaction retires rewrites but keeps original retrieval", async () => {
		const { sm, start, end } = seed();
		const h = harness(sm); await h.command("on"); h.request();
		await h.call("compress", { startId: start, endId: end, summary: "Expiry fixed." });
		const block = readBlocks(sm.getBranch())[0]!;
		sm.appendCompaction("Host summary", sm.getLeafId()!, 90_000);
		h.fire("session_compact");
		expect(JSON.stringify(h.request())).not.toContain("Compressed history");
		expect((await h.call("decompress", { blockId: block.id })).content[0]).toMatchObject({ text: expect.stringContaining("TOKEN_EXPIRED") });
	});

	test("adds a pressure reminder only when enabled, over threshold, and eligible work exists", async () => {
		const { sm } = seed(); const h = harness(sm);
		h.pressure(100); expect(JSON.stringify(h.request())).not.toContain("at least 100,000 tokens");
		await h.command("on"); expect(JSON.stringify(h.request())).toContain("at least 100,000 tokens");
		h.pressure(99.999); expect(messageText(h.request().at(-1)!)).toContain("reminder cleared");
		const empty = harness(SessionManager.inMemory()); await empty.command("on"); empty.pressure(100);
		expect(JSON.stringify(empty.request())).not.toContain("at least 100,000 tokens");
	});

	test("extends the entire prior request, including summaries, references, and pressure updates", async () => {
		const { sm, start, end } = seed();
		const h = harness(sm); await h.command("on");
		const history = structuredClone(sm.buildSessionContext().messages);
		const first = h.request();
		expect(first.slice(0, history.length)).toEqual(history);
		expect(messageText(first.at(-1)!)).toContain(`[context-ref ${start}]`);
		expect(h.request()).toEqual(first);
		await h.call("compress", { startId: start, endId: end, summary: "Expiry fixed." });
		let previous = h.request();
		let previousWire = effectiveInputForBranch({ branch: sm.getBranch(), model, tools: [], compression: on });
		expect(messageText(previous[1]!)).toContain("[Compressed history");
		for (let i = 0; i < 5; i++) {
			sm.appendMessage(assistant([toolCall(`step-${i}`)]));
			sm.appendMessage(toolResult(`step-${i}`, `Result ${i}`));
			h.pressure(i < 2 ? 100 : 20);
			const next = h.request();
			expect(next.slice(0, previous.length)).toEqual(previous);
			expect(h.request()).toEqual(next);
			const wire = effectiveInputForBranch({ branch: sm.getBranch(), model, tools: [], compression: { enabled: true, pressure: i < 2 } });
			expect(wire.slice(0, previousWire.length)).toEqual(previousWire);
			expect(JSON.stringify(wire)).toContain("Expiry fixed.");
			previousWire = wire;
			previous = next;
		}
		expect(JSON.stringify(previous)).toContain("reminder cleared");
		expect(harness(sm).request()).toEqual(previous);
		expect(sm.buildSessionContext().messages.slice(0, history.length)).toEqual(history);
	});

	test("rejects malformed persisted hints", () => {
		const { sm } = seed();
		sm.appendCustomEntry(HINT_TYPE, { version: 1, ids: "not an array" });
		expect(() => projectContext(sm.buildSessionContext().messages, sm.getBranch(), on)).toThrow("Invalid compression hint");
	});

	test("never restores messages removed by another projection or mutates raw history", () => {
		const { sm, start, end } = seed();
		const originalMessages = structuredClone(sm.buildSessionContext().messages);
		sm.appendCustomEntry(BLOCK_TYPE, { version: 1, ids: [start, end], summary: "Expiry fixed." });
		const partial = originalMessages.filter((m) => m.role !== "toolResult");
		const projected = projectContext(partial, sm.getBranch(), on);
		expect(projected.messages.some((m) => m.role === "toolResult")).toBe(false);
		expect(JSON.stringify(projected.messages)).not.toContain("Compressed history");
		expect(sm.buildSessionContext().messages).toEqual(originalMessages);
	});
});

test("real Pi sends compressed HTTP history after executing compress and restores it when toggled off", async () => {
	const coreDir = resolve(dirname(piCli), "../core");
	const { createAgentSession } = await import(resolve(coreDir, "sdk.js"));
	const { DefaultResourceLoader } = await import(resolve(coreDir, "resource-loader.js"));
	const { SettingsManager } = await import(resolve(coreDir, "settings-manager.js"));
	const { ModelRuntime } = await import(resolve(coreDir, "model-runtime.js"));
	const dir = mkdtempSync(resolve(tmpdir(), "pi-compression-test-"));
	const { sm, start, end } = seed(SessionManager.inMemory(dir));
	const requests: Record<string, unknown>[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			requests.push(await request.json() as Record<string, unknown>);
			const first = requests.length === 1;
			const callingTool = requests.length <= 3;
			const delta = callingTool ? { tool_calls: [{ index: 0, id: `http-${requests.length}`, type: "function", function: first ? {
				name: "compress", arguments: JSON.stringify({ startId: start, endId: end, summary: "Fixed expiry in auth.ts. Keep public APIs unchanged." }),
			} : { name: "search_context", arguments: JSON.stringify({ query: "not found" }) } }] } : { content: "Done." };
			const event = { id: "chat-test", object: "chat.completion.chunk", model: "test", created: 1, choices: [{ index: 0, delta, finish_reason: null }] };
			const done = { ...event, choices: [{ index: 0, delta: {}, finish_reason: callingTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
			return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	let session: { prompt(text: string): Promise<void>; dispose(): void; bindExtensions(options: object): Promise<void> } | undefined;
	try {
		writeFileSync(resolve(dir, "models.json"), JSON.stringify({ providers: { compressionTest: {
			baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-test-only",
			models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1024 }],
		} } }));
		const runtime = await ModelRuntime.create({ authPath: resolve(dir, "auth.json"), modelsPath: resolve(dir, "models.json"), modelsStorePath: resolve(dir, "models-store.json") });
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			extensionFactories: [extension], agentsFilesOverride: () => ({ agentsFiles: [] }), systemPromptOverride: () => "Test assistant.",
		});
		await loader.reload();
		const created = await createAgentSession({ cwd: dir, agentDir: dir, model: runtime.getModel("compressionTest", "test"), modelRuntime: runtime,
			settingsManager: settings, resourceLoader: loader, sessionManager: sm, noTools: "builtin", thinkingLevel: "off" });
		session = created.session;
		await session!.bindExtensions({ mode: "print" });
		await session!.prompt("/compression on");
		await session!.prompt("Continue the task.");
		expect(requests).toHaveLength(4);
		expect(JSON.stringify(requests[0])).toContain("TOKEN_EXPIRED");
		expect(JSON.stringify(requests[0])).toContain(`[context-ref ${start}]`);
		expect(JSON.stringify(requests[1])).not.toContain(JSON.stringify(original).slice(1, -1));
		for (let i = 2; i < requests.length; i++) {
			const previous = requests[i - 1]!.messages as unknown[];
			expect((requests[i]!.messages as unknown[]).slice(0, previous.length)).toEqual(previous);
		}
		expect(JSON.stringify(requests[1])).toContain("[Compressed history");
		expect(readBlocks(sm.getBranch())).toHaveLength(1);
		const systemMessages = (request: Record<string, unknown>) => (request.messages as { role: string }[]).filter((message) => message.role === "system" || message.role === "developer");
		expect(systemMessages(requests[0]!)).not.toHaveLength(0);
		expect(systemMessages(requests[1]!)).toEqual(systemMessages(requests[0]!));
		await session!.prompt("Continue without changing compression mode.");
		expect(systemMessages(requests[4]!)).toEqual(systemMessages(requests[0]!));
		await session!.prompt("/compression off");
		await session!.prompt("Check the original history.");
		expect(requests).toHaveLength(6);
		expect(JSON.stringify(requests[5])).toContain(JSON.stringify(original).slice(1, -1));
		expect(JSON.stringify(requests[5])).not.toContain("[Compressed history");
	} finally {
		session?.dispose(); server.stop(true); rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);

describe("Codex wire replay", () => {
	test("preserves an opaque checkpoint and compresses only its tail, with off restoring that tail", async () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage(user("Pre-checkpoint history"));
		const opaque = { type: "compaction", encrypted_content: "opaque-checkpoint" };
		sm.appendCustomEntry(NATIVE_COMPACTION_KIND, {
			kind: NATIVE_COMPACTION_KIND, version: 2, modelKey: modelKey(model), sessionId: sm.getSessionId(),
			checkpointId: "checkpoint", sourceLeafId: sm.getLeafId(), replacementHistory: [opaque],
		});
		const { start, end } = seed(sm);
		const h = harness(sm); await h.command("on"); h.request();
		await h.call("compress", { startId: start, endId: end, summary: "Expiry fixed in auth.ts." });
		const params = { branch: sm.getBranch(), model, tools: [], sessionId: sm.getSessionId() };
		const input = effectiveInputForBranch({ ...params, compression: on });
		expect(input[0]).toEqual(opaque);
		expect(JSON.stringify(input)).toContain("Expiry fixed in auth.ts.");
		expect(input.some((item) => item.type === "function_call" || item.type === "function_call_output")).toBe(false);
		expect(JSON.stringify(input)).not.toContain(JSON.stringify(original).slice(1, -1));
		const restored = effectiveInputForBranch({ ...params, compression: { enabled: false, pressure: false } });
		expect(restored[0]).toEqual(opaque);
		expect(restored.some((item) => item.type === "function_call_output" && item.output === original)).toBe(true);

		const { default: codexExtension } = await import("../codex-compaction/index.ts");
		const handlers = new Map<string, Handler>();
		codexExtension({
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			registerCommand() {}, getAllTools: () => [], events: { on() {} },
		} as unknown as ExtensionAPI);
		const request = { payload: { input: [], service_tier: "priority" } };
		const rewritten = await handlers.get("before_provider_request")!(request, h.ctx);
		expect(rewritten.input).toEqual(input);
		expect(rewritten.service_tier).toBe("priority");
		await h.command("off");
		const offRequest = await handlers.get("before_provider_request")!(request, h.ctx);
		expect(offRequest.input).toEqual(restored);
	});
});
