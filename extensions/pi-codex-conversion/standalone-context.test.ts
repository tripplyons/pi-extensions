import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { appendActiveMessage, createLocalContext, scheduleContextTransition } from "./local-context.ts";
import { encodeStandaloneContext, materializeStandaloneContext, restoreStandaloneContext, snapshotStandaloneContext, type StandaloneContextSnapshot } from "./standalone-context.ts";

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

test("standalone context deltas restore the latest state without duplicating pending messages", () => {
	const { manager, state } = fixture();
	let persisted: StandaloneContextSnapshot | undefined;
	for (let index = 0; index < 4; index++) {
		const message = user(`follow-up-${index}`);
		appendActiveMessage(state, message);
		const snapshot = snapshotStandaloneContext(state, manager.getBranch(), true);
		const entry = encodeStandaloneContext(snapshot, persisted);
		expect(entry).toBeDefined();
		manager.appendCustomEntry("local", entry!);
		persisted = snapshot;
		manager.appendMessage(message);
	}
	const restored = materializeStandaloneContext(manager.getBranch(), convertToLlm(manager.buildSessionContext().messages), "local");
	expect(restored?.state.activeMessages.map(message => message.role === "user" ? message.content : message.role)).toEqual([
		"task", "follow-up-0", "follow-up-1", "follow-up-2", "follow-up-3",
	]);
	expect(restored?.persisted).toEqual(persisted);
});

test("legacy insertion-order hashes remain readable after canonical hashing", () => {
	const { manager, state } = fixture();
	const legacyHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const first = snapshotStandaloneContext(state, manager.getBranch());
	manager.appendCustomEntry("local", { version: 2, kind: "snapshot", hash: legacyHash(first), snapshot: first });
	appendActiveMessage(state, user("legacy delta"));
	const second = snapshotStandaloneContext(state, manager.getBranch());
	const encoded = encodeStandaloneContext(second, first);
	if (!encoded || encoded.kind !== "delta") throw new Error("Expected fixture delta");
	manager.appendCustomEntry("local", { ...encoded, baseHash: legacyHash(first), hash: legacyHash(second) });
	const restored = materializeStandaloneContext(manager.getBranch(), convertToLlm(manager.buildSessionContext().messages), "local");
	expect(restored?.persisted).toEqual(second);
});

test("corrupt and orphaned delta chains fail without mutating stored session entries", () => {
	const { manager, state } = fixture();
	const first = snapshotStandaloneContext(state, manager.getBranch());
	const base = encodeStandaloneContext(first)!;
	manager.appendCustomEntry("local", base);
	appendActiveMessage(state, user("changed"));
	const second = snapshotStandaloneContext(state, manager.getBranch());
	const delta = encodeStandaloneContext(second, first)!;
	manager.appendCustomEntry("local", { ...delta, hash: "0".repeat(64) });
	const before = structuredClone(manager.getEntries());
	expect(() => materializeStandaloneContext(manager.getBranch(), convertToLlm(manager.buildSessionContext().messages), "local"))
		.toThrow("Invalid standalone local context delta hash");
	expect(manager.getEntries()).toEqual(before);

	const orphan = SessionManager.inMemory(process.cwd());
	orphan.appendCustomEntry("local", delta);
	expect(() => materializeStandaloneContext(orphan.getBranch(), [], "local"))
		.toThrow("Standalone local context delta has no base snapshot");
});

test("a later validated snapshot starts a fresh chain after obsolete corrupt data", () => {
	const { manager, state } = fixture();
	const first = snapshotStandaloneContext(state, manager.getBranch());
	manager.appendCustomEntry("local", encodeStandaloneContext(first)!);
	manager.appendCustomEntry("local", { version: 2, kind: "delta", baseHash: "bad", hash: "bad", changes: [] });
	appendActiveMessage(state, user("fresh snapshot"));
	const fresh = snapshotStandaloneContext(state, manager.getBranch());
	manager.appendCustomEntry("local", encodeStandaloneContext(fresh)!);
	const restored = materializeStandaloneContext(manager.getBranch(), convertToLlm(manager.buildSessionContext().messages), "local");
	expect(restored?.persisted).toEqual(fresh);
	expect(JSON.stringify(restored?.state.activeMessages)).toContain("fresh snapshot");
});

test("standalone persistence grows with new content instead of rewriting full history", () => {
	const { manager, state } = fixture();
	let persisted: StandaloneContextSnapshot | undefined;
	let storedBytes = 0;
	for (let index = 0; index < 100; index++) {
		const message = user(`${index}:${"x".repeat(4_000)}`);
		appendActiveMessage(state, message);
		const snapshot = snapshotStandaloneContext(state, manager.getBranch(), true);
		const entry = encodeStandaloneContext(snapshot, persisted);
		expect(entry).toBeDefined();
		storedBytes += JSON.stringify(entry).length;
		manager.appendCustomEntry("local", entry!);
		persisted = snapshot;
		manager.appendMessage(message);
	}
	const finalSnapshotBytes = JSON.stringify(persisted).length;
	expect(storedBytes).toBeLessThan(finalSnapshotBytes * 3);
	expect(storedBytes).toBeLessThan(3_000_000);
});
