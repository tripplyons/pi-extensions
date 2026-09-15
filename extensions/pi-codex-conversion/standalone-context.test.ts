import { expect, test } from "bun:test";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { appendActiveMessage, createLocalContext, scheduleContextTransition } from "./local-context.ts";
import { restoreStandaloneContext, snapshotStandaloneContext } from "./standalone-context.ts";

const identity = { branchId: "branch", preset: "standalone-codex", role: "/root" };
const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const assistant = (name?: string): AssistantMessage => ({ role: "assistant", provider: "fixture", model: "fixture", api: "fixture", timestamp: 2,
	content: name ? [{ type: "toolCall", id: "call", name, arguments: {} }] : [{ type: "text", text: "answer" }], stopReason: name ? "toolUse" : "stop",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
function fixture() {
	const manager = SessionManager.inMemory(process.cwd());
	const message = user("task");
	manager.appendMessage(message);
	return { manager, state: createLocalContext(identity, [message]) };
}
function restore(manager: SessionManager, index: number) {
	const branch = manager.getBranch();
	const entry = branch[index];
	if (entry.type !== "custom") throw new Error("Expected fixture snapshot");
	return restoreStandaloneContext(entry.data, branch, index, convertToLlm(manager.buildSessionContext().messages));
}

test("message-end snapshots do not duplicate the native message appended after the hook", () => {
	const { manager, state } = fixture();
	const message = assistant();
	appendActiveMessage(state, message);
	manager.appendCustomEntry("local", snapshotStandaloneContext(state, manager.getBranch(), true));
	const index = manager.getBranch().length - 1;
	manager.appendMessage(message);
	manager.appendMessage(user("follow-up"));
	const entries = structuredClone(manager.getEntries());
	const recovered = restore(manager, index);
	expect(recovered.activeMessages).toEqual([...state.activeMessages, user("follow-up")]);
	expect(recovered.activeItems.slice(0, 2)).toEqual(state.activeItems);
	expect(manager.getEntries()).toEqual(entries);
});

for (const recorded of [false, true]) test(`partial-batch restart ${recorded ? "honors a recorded transition" : "repairs an unconfirmed transition without replay"}`, () => {
	const { manager, state } = fixture();
	const message = assistant("new_context");
	appendActiveMessage(state, message);
	manager.appendMessage(message);
	scheduleContextTransition(state);
	manager.appendCustomEntry("local", snapshotStandaloneContext(state, manager.getBranch()));
	const index = manager.getBranch().length - 1;
	if (recorded) manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "new_context", content: [{ type: "text", text: "accepted" }], isError: false, timestamp: 3 });
	const recovered = restore(manager, index);
	expect(recovered.pending).toBeUndefined();
	expect(recovered.archives).toHaveLength(recorded ? 1 : 0);
	const results = recovered.activeMessages.filter(message => message.role === "toolResult");
	expect(results).toHaveLength(1);
	expect(results[0].isError).toBe(!recorded);
});

test("restore retains recorded checkout results that arrived after the local snapshot", () => {
	const { manager, state } = fixture();
	manager.appendCustomEntry("local", snapshotStandaloneContext(state, manager.getBranch()));
	const index = manager.getBranch().length - 1;
	manager.appendMessage(assistant("write"));
	manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "write", content: [{ type: "text", text: "file changed" }], isError: false, timestamp: 3 });
	const recovered = restore(manager, index);
	expect(recovered.activeMessages.filter(message => message.role === "toolResult")).toMatchObject([{ isError: false, content: [{ text: "file changed" }] }]);
});

test("a native compaction after the snapshot archives old content and preserves the converted summary", () => {
	const { manager, state } = fixture();
	appendActiveMessage(state, user("old-secret"));
	manager.appendMessage(user("old-secret"));
	manager.appendCustomEntry("local", snapshotStandaloneContext(state, manager.getBranch()));
	const index = manager.getBranch().length - 1;
	const keptId = manager.appendMessage(user("kept-tail"));
	manager.appendCompaction("native-summary-sentinel", keptId, 100);
	const recovered = restore(manager, index);
	expect(JSON.stringify(recovered.activeMessages)).toContain("native-summary-sentinel");
	expect(JSON.stringify(recovered.activeMessages)).toContain("kept-tail");
	expect(JSON.stringify(recovered.activeMessages)).not.toContain("old-secret");
	expect(JSON.stringify(recovered.archives)).toContain("old-secret");
});

test("raw v1 snapshots remain readable and foreign cursors are rejected", () => {
	const { manager, state } = fixture();
	manager.appendCustomEntry("local", state);
	const index = manager.getBranch().length - 1;
	expect(restore(manager, index).activeMessages).toEqual(state.activeMessages);
	const snapshot = snapshotStandaloneContext(state, manager.getBranch());
	snapshot.cursor.entryId = "foreign";
	expect(() => restoreStandaloneContext(snapshot, manager.getBranch(), index, [])).toThrow("not on the selected branch");
});
