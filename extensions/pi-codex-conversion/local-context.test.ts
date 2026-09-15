import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import {
	MAX_NOTE_FILE_BYTES,
	appendActiveMessage,
	cancelContextTransition,
	commitContextTransition,
	contextRemaining,
	createLocalContext,
	detachedContextSnapshot,
	localHistory,
	localNotes,
	parseLocalContext,
	reconcileLocalContext,
	replaceActiveMessages,
	scheduleContextTransition,
	serializeLocalContext,
} from "./local-context.ts";
import { createLocalContextTools } from "./local-context-tools.ts";

const identity = { branchId: "branch-a", preset: "lead", role: "lead" };
const user = (content: string) => ({ role: "user", content, timestamp: 1 }) as Message;
const assistant = (content: string) => ({ role: "assistant", content: [{ type: "text", text: content }], api: "openai-responses", provider: "openai-codex", model: "gpt", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 }) as Message;

describe("local context state", () => {
	test("round-trips v1 state and rejects malformed versions", () => {
		const state = createLocalContext(identity, [user("task")]);
		expect(parseLocalContext(serializeLocalContext(state))).toEqual(state);
		expect(() => parseLocalContext({ ...state, version: 2 })).toThrow("Invalid local context v1 state");
	});

	test("rejects malformed messages, inconsistent projections, duplicate notes, and reused transition IDs", () => {
		const state = createLocalContext(identity, [user("task")]);
		const malformed = [
			() => { (state.activeMessages[0] as any).content = [{ type: "image", mimeType: "image/png" }]; },
			() => { state.activeItems[0].content = "foreign"; },
			() => { state.notes = [{ path: "lead/notes/a", text: "one", createdAt: 1, updatedAt: 1 }, { path: "lead/notes/a", text: "two", createdAt: 1, updatedAt: 1 }]; },
			() => { state.pending = { fromWindowId: state.activeWindowId, toWindowId: state.activeWindowId, requestedAt: 1 }; },
		];
		for (const mutate of malformed) {
			const candidate = serializeLocalContext(createLocalContext(identity, [user("task")]));
			Object.assign(state, candidate); mutate();
			expect(() => parseLocalContext(state)).toThrow("Invalid");
		}
	});

	test("keeps actor stores isolated", () => {
		const lead = createLocalContext(identity, [user("lead secret")]);
		const writer = createLocalContext({ ...identity, role: "writer", preset: "writer" }, [user("writer secret")]);
		scheduleContextTransition(lead); commitContextTransition(lead);
		scheduleContextTransition(writer); commitContextTransition(writer);
		expect(JSON.stringify(localHistory(lead, "search_contents", { query: "writer" }))).not.toContain("writer secret");
		expect(JSON.stringify(localHistory(writer, "search_contents", { query: "lead" }))).not.toContain("lead secret");
	});

	test("successive windows project private notes and the current task while retaining old history", () => {
		const state = createLocalContext(identity, [user("old-window-sentinel")]);
		localNotes(state, "write_file", { path: "facts", text: "private-note-sentinel" });
		for (let window = 0; window < 2; window++) {
			scheduleContextTransition(state);
			commitContextTransition(state, { currentTask: user("current-task-sentinel"), boundaryGroup: [assistant(`boundary-${window}`)] });
			const projection = JSON.stringify(state.activeMessages);
			expect(projection).toContain("private-note-sentinel");
			expect(projection).toContain("current-task-sentinel");
			expect(projection).not.toContain("old-window-sentinel");
			expect(JSON.stringify(localHistory(state, "search_contents", { query: "old-window-sentinel" }))).toContain("old-window-sentinel");
		}
		expect(state.archives).toHaveLength(2);
	});

	test("commits rollover atomically and cancellation leaves durable state unchanged", () => {
		const state = createLocalContext(identity, [user("task"), assistant("result")]);
		const before = detachedContextSnapshot(state);
		scheduleContextTransition(state, 10);
		cancelContextTransition(state);
		expect(state).toEqual(before);

		scheduleContextTransition(state, 11);
		expect(commitContextTransition(state, { summary: "summary", notesPrompt: user("notes"), currentTask: user("task"), boundaryGroup: [assistant("boundary")] })).toBeTrue();
		expect(state.archives).toHaveLength(1);
		expect(state.archives[0]!.items.map(item => item.content)).toEqual(["task", "result"]);
		expect(state.activeMessages.map(message => typeof message.content === "string" ? message.content : (message.content[0] as { text: string }).text)).toEqual(["notes", "task", "boundary"]);
		expect(state.pending).toBeUndefined();
	});
});

test("projection replacement preserves stable item IDs for retained messages", () => {
	const messages = [user("first"), user("second")];
	const state = createLocalContext(identity, messages);
	const ids = state.activeItems.map(item => item.id);
	replaceActiveMessages(state, [...messages, user("third")]);
	expect(state.activeItems.slice(0, 2).map(item => item.id)).toEqual(ids);
	replaceActiveMessages(state, state.activeMessages.slice(1));
	expect(state.activeItems[0].id).toBe(ids[1]);
});

test("archives retain original image messages as well as searchable text", () => {
	const message: Message = { role: "user", timestamp: 1, content: [{ type: "image", mimeType: "image/png", data: "cGl4ZWw=" }] };
	const state = createLocalContext(identity, [message]);
	scheduleContextTransition(state); commitContextTransition(state);
	expect(parseLocalContext(serializeLocalContext(state)).archives[0].messages).toEqual([message]);
});

for (const accepted of [false, true]) test(`restore ${accepted ? "commits recorded" : "cancels unconfirmed"} window transitions without replay`, () => {
	const call = { ...assistant(""), content: [{ type: "toolCall", id: "switch", name: "new_context", arguments: {} }], stopReason: "toolUse" } as Message;
	const state = createLocalContext(identity, [user("task"), call]);
	const originalWindow = state.activeWindowId;
	const ids = state.activeItems.map(item => item.id);
	scheduleContextTransition(state);
	if (accepted) appendActiveMessage(state, { role: "toolResult", toolCallId: "switch", toolName: "new_context", content: [{ type: "text", text: "accepted" }], isError: false, timestamp: 2 });
	reconcileLocalContext(state, user("task"));
	expect(state.pending).toBeUndefined();
	expect(state.archives).toHaveLength(accepted ? 1 : 0);
	if (accepted) expect(state.activeWindowId).not.toBe(originalWindow);
	else expect(state.activeWindowId).toBe(originalWindow);
	expect((accepted ? state.archives[0].items : state.activeItems).slice(0, 2).map(item => item.id)).toEqual(ids);
	const reconciled = serializeLocalContext(state);
	reconcileLocalContext(state, user("task"));
	expect(state).toEqual(reconciled);
});

test("new_context refuses an oversized note projection before changing windows", async () => {
	const state = createLocalContext(identity, [user("task"), { ...assistant(""), content: [{ type: "toolCall", id: "switch", name: "new_context", arguments: {} }], stopReason: "toolUse" } as Message]);
	state.notes.push({ path: "lead/notes/large", text: "x".repeat(900_000), createdAt: 1, updatedAt: 1 });
	const tools = createLocalContextTools({ events: { emit() {} } } as any, () => ({ state, contextWindow: 100_000, reserveTokens: 20_000, changed() {} }));
	const tool = tools.find(tool => tool.name === "new_context")!;
	await expect(tool.execute("switch", {}, new AbortController().signal, undefined, { sessionManager: { getSessionId: () => "branch" } } as any)).rejects.toThrow("input budget; the current window was preserved");
	expect(state.pending).toBeUndefined();
	expect(state.archives).toEqual([]);
});

describe("local history", () => {
	test("lists, searches, and reads archived items with bounded output", () => {
		const state = createLocalContext(identity, [user("needle-" + "x".repeat(2_000))]);
		scheduleContextTransition(state); commitContextTransition(state);
		const windows = localHistory(state, "list_windows", {});
		const windowId = (windows.windows as Array<{ window_id: string }>)[0]!.window_id;
		const listed = localHistory(state, "list_items", { window_id: windowId });
		const itemId = (listed.items as Array<{ item_id: string; truncated_content: string }>)[0]!.item_id;
		expect((listed.items as Array<{ truncated_content: string }>)[0]!.truncated_content.length).toBe(1_000);
		expect((localHistory(state, "search_contents", { query: "needle" }).items as unknown[])).toHaveLength(1);
		const read = localHistory(state, "read_item", { window_id: windowId, item_id: itemId, offset_chars: 7, limit_chars: 5 });
		expect((read.item as { content: string }).content).toBe("xxxxx");
	});
});

describe("local notes", () => {
	test("supports compatible paths, listing, searching, reading, writing, and appending", () => {
		const state = createLocalContext(identity);
		localNotes(state, "write_file", { path: "facts.md", text: "one\ntwo" }, 1);
		localNotes(state, "append_to_file", { path: "/lead/notes/facts.md", text: "\nthree" }, 2);
		expect((localNotes(state, "list_files_by_prefix", { prefix: "" }).files as unknown[])).toHaveLength(1);
		expect(JSON.stringify(localNotes(state, "search_contents", { query: "three" }))).toContain("line_number");
		expect((localNotes(state, "read_file", { path: "facts.md", start_line: -1 }).file as { content: string }).content).toBe("three");
		expect(() => localNotes(state, "read_file", { path: "/writer/notes/private" })).toThrow("Cross-role");
	});

	test("enforces the one-megabyte file limit without partial writes", () => {
		const state = createLocalContext(identity);
		localNotes(state, "write_file", { path: "safe", text: "ok" });
		expect(() => localNotes(state, "write_file", { path: "safe", text: "x".repeat(MAX_NOTE_FILE_BYTES + 1) })).toThrow("1,000,000-byte");
		expect((localNotes(state, "read_file", { path: "safe" }).file as { content: string }).content).toBe("ok");
	});
});

test("remaining context reserves output and preserves unknown usage", () => {
	const state = createLocalContext(identity);
	expect(contextRemaining(state, 10_000, 2_000, 3_000).remainingTokens).toBe(5_000);
	expect(contextRemaining(state, 10_000, 2_000).remainingTokens).toBeUndefined();
});
