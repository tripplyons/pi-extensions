import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Message, type Model } from "@earendil-works/pi-ai";
import { compactRole, forModel, imageContent, interruptPending, messageGroups } from "./context.ts";
import { defaultConfig } from "./config.ts";
import { emitMessage, emptyUsage, type Registry } from "./provider.ts";
import { MixtureSession, newState } from "./session.ts";

const user = (content: Message["content"]): Message => ({ role: "user", timestamp: 1, content } as Message);
const model: Model<any> = { id: "lead", provider: "fixture", api: "fixture", name: "lead", baseUrl: "", input: ["text", "image"], reasoning: true, contextWindow: 32_000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const answer = (text: string, tokens = 1): AssistantMessage => ({ role: "assistant", api: "fixture", provider: "fixture", model: "lead", timestamp: 1, stopReason: "stop", content: [{ type: "text", text }], usage: { ...emptyUsage(), input: tokens, totalTokens: tokens } });
const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

test("repairs interrupted batches without replay and keeps complete tool groups", () => {
	const messages: Message[] = [{ ...answer(""), stopReason: "toolUse", content: ["one", "two"].map(id => ({ type: "toolCall" as const, id, name: "write", arguments: { path: id, content: "done" } })) },
		{ role: "toolResult", toolCallId: "one", toolName: "write", timestamp: 1, isError: false, content: [{ type: "text", text: "written" }] }, user("continue")];
	expect(interruptPending(messages)).toBe(true);
	expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "two", isError: true });
	expect(JSON.stringify(messages[2])).toContain("never replay");
	expect(messageGroups(messages).map(group => group.length)).toEqual([3, 1]);
	expect(interruptPending(messages)).toBe(false);
});

test("text-only filtering warns without destroying retained image evidence", () => {
	const context: Context = { messages: [user([{ type: "text", text: "Check this" }, image])] };
	const warnings: string[] = [];
	const filtered = forModel(context, { ...model, input: ["text"] }, warning => warnings.push(warning));
	expect(imageContent(filtered.messages)).toEqual([]);
	expect(warnings[0]).toContain("text only");
	expect(imageContent(context.messages)).toEqual([image]);
	expect(forModel(context, model, () => { throw new Error("vision should not warn"); })).toBe(context);
});

test("role compaction preserves current facts, images and complete recent tool batches", async () => {
	const messages: Message[] = [user([{ type: "text", text: "Original task" }, image]), answer("Earlier plan"), user("earlier feedback"),
		{ ...answer(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "fixture" } }] },
		{ role: "toolResult", toolCallId: "read", toolName: "read", timestamp: 1, isError: false, content: [{ type: "text", text: "current file" }] }, user("Current requirement")];
	let summaries = 0;
	const compacted = await compactRole({ messages }, model, 512, "Keep unrelated edits; verify fixture", async context => {
		summaries++;
		expect(context.tools).toBeUndefined();
		expect(JSON.stringify(context.messages)).toContain("Original task");
		return answer("Earlier decisions and verification");
	}, true);
	expect(summaries).toBe(1);
	expect(compacted.changed).toBe(true);
	expect(imageContent(compacted.messages)).toEqual([image]);
	expect(JSON.stringify(compacted.messages)).toContain("Keep unrelated edits; verify fixture");
	expect(messageGroups(compacted.messages).map(group => group.length)).toEqual([1, 2, 1]);
	expect(messages).toHaveLength(6);
	await expect(compactRole({ messages }, model, 512, "facts", async () => ({ ...answer(""), stopReason: "error", errorMessage: "summary failed" }), true)).rejects.toThrow("last checkpoint preserved");
	expect(messages).toHaveLength(6);
});

test("one overflow retry charges the failed call, summary and successful candidate once", async () => {
	const preset = defaultConfig().presets.default;
	preset.lead = "fixture/lead"; preset.writer.model = "fixture/writer"; preset.reviewers = [];
	const requests: Context[] = [];
	const registry: Registry = { find: (provider, id) => ({ ...model, provider, id }), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }), getProvider: () => ({ streamSimple: (_model: Model<any>, context: Context) => {
		requests.push(context);
		const message = requests.length === 1 ? { ...answer("", 3), stopReason: "error" as const, errorMessage: "maximum context length exceeded" } : answer(requests.length === 2 ? "Context summary" : "Final answer", requests.length === 2 ? 5 : 7);
		const stream = createAssistantMessageEventStream(); emitMessage(stream, message); return stream;
	} } as any) };
	const state = newState("default", preset); state.initialized = true; state.lead.messages = [user("old task"), answer("plan"), user("update")];
	const session = new MixtureSession(preset, registry, state, () => ({ available: true, jobs: [] }));
	const checkpoint = await session.next({ messages: [user("Verify current files")] }, {}, "off");
	const call = checkpoint.content.find(block => block.type === "toolCall")!;
	expect(call.arguments.action).toBe("checkpoint");
	const receipt = await session.control(call.id, call.arguments as any);
	const final = await session.next({ messages: [user("Verify current files")] });
	expect(requests).toHaveLength(3);
	expect(requests[1].tools).toBeUndefined();
	expect(state.lead.summaries).toBe(1);
	expect(receipt.usage.totalTokens).toBe(15);
	expect(final.usage.totalTokens).toBe(7);
	expect(session.usage.totalTokens).toBe(15);
	expect(session.takeUsage().totalTokens).toBe(0);
	await session.abort();
});
