import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT, CHECKPOINT_BLOB, checkpointBlobs, encodeCheckpoint, MAX_DELTA_CHAIN, parseCheckpoint, restoreCheckpoint } from "./checkpoint.ts";
import { defaultConfig } from "./config.ts";
import { emptyUsage } from "./provider.ts";
import { MixtureSession, newState } from "./session.ts";
import { receipt, tagReceipts } from "./usage.ts";

const cwd = process.cwd();
const preset = defaultConfig().presets.default;
const assistant = (): AssistantMessage => ({ role: "assistant", provider: "openai-codex", model: "gpt-6-astra", api: "fixture", stopReason: "toolUse", timestamp: 1,
	content: [{ type: "toolCall", id: "write", name: "write", arguments: { path: "fixture", content: "changed" } }], usage: { ...emptyUsage(), input: 9, totalTokens: 9 } });
function fixture() {
	const manager = SessionManager.inMemory(cwd);
	const state = newState("default", preset);
	state.initialized = true;
	const message = assistant();
	const row = receipt("lead", preset.lead, message, "reported");
	tagReceipts(message, [row.id]);
	state.receipts.push(row); state.lead.messages.push(message); state.lead.usage = structuredClone(message.usage); state.lead.calls = 1;
	state.owner = "lead"; state.origins.write = { actor: "lead", synthetic: false };
	return { manager, state, message, row };
}

test("version 3 checkpoints store small deltas and restore their full state", () => {
	const manager = SessionManager.inMemory(cwd);
	const before = newState("default", preset);
	before.initialized = true;
	before.diagnostics!.tacticalReviewsSkipped = 2;
	before.diagnostics!.jobReconciliations = 1;
	before.lead.messages.push({ role: "user", content: "x".repeat(200_000), timestamp: 1 });
	const snapshot = encodeCheckpoint(cwd, "response", before);
	manager.appendCustomEntry(CHECKPOINT, snapshot);
	const after = structuredClone(before);
	after.revision = 1;
	after.writerRetries = 1;
	after.writerRetryDelegation = 1;
	after.writerReportRejections = 2;
	after.lead.messages.push({ role: "user", content: "small follow-up", timestamp: 2 });
	const delta = encodeCheckpoint(cwd, "turn", after, before);
	expect(delta.kind).toBe("delta");
	expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(snapshot).length / 100);
	manager.appendCustomEntry(CHECKPOINT, delta);
	const restored = restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd);
	expect(restored.warning).toBeUndefined();
	expect(restored.state).toEqual(after);
});

test("image blobs are stored once while snapshots, deltas and markers keep references", () => {
	const manager = SessionManager.inMemory(cwd);
	const state = newState("default", preset);
	const image = { type: "image" as const, mimeType: "image/png", data: "image-data".repeat(200_000) };
	state.attachments = [image];
	state.writer.messages.push({ role: "user", timestamp: 1, content: [{ type: "text", text: "inspect" }, image] });
	const blobs = checkpointBlobs(state);
	expect(blobs).toHaveLength(1);
	manager.appendCustomEntry(CHECKPOINT_BLOB, blobs[0]);
	const snapshot = encodeCheckpoint(cwd, "response", state);
	manager.appendCustomEntry(CHECKPOINT, snapshot);
	const marker = encodeCheckpoint(cwd, "turn", structuredClone(state), state);
	manager.appendCustomEntry(CHECKPOINT, marker);
	expect(marker.kind).toBe("marker");
	expect(JSON.stringify(snapshot)).not.toContain("image-data");
	expect(JSON.stringify(marker).length).toBeLessThan(300);
	expect(restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd).state?.attachments).toEqual([image]);
});

test("missing image blobs reject a referenced checkpoint visibly", () => {
	const manager = SessionManager.inMemory(cwd);
	const state = newState("default", preset);
	state.attachments = [{ type: "image", mimeType: "image/png", data: "missing" }];
	manager.appendCustomEntry(CHECKPOINT, encodeCheckpoint(cwd, "response", state));
	const restored = restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd);
	expect(restored.state).toBeUndefined();
	expect(restored.warning).toContain("missing or corrupt image blob");
});

test("periodic snapshots bound restore chains without returning to quadratic growth", () => {
	const manager = SessionManager.inMemory(cwd);
	let previous: ReturnType<typeof newState> | undefined;
	let chain = 0;
	let bytes = 0;
	let snapshots = 0;
	let fullSize = 0;
	for (let revision = 0; revision < 200; revision++) {
		const state = previous ? structuredClone(previous) : newState("default", preset);
		if (!state.lead.messages.length) state.lead.messages.push({ role: "user", content: "x".repeat(200_000), timestamp: 1 });
		state.revision = revision;
		const stored = encodeCheckpoint(cwd, "turn", state, chain < MAX_DELTA_CHAIN ? previous : undefined);
		manager.appendCustomEntry(CHECKPOINT, stored);
		const size = JSON.stringify(stored).length;
		bytes += size;
		if (stored.kind === "snapshot") { snapshots++; fullSize ||= size; chain = 0; }
		else chain++;
		previous = state;
	}
	expect(snapshots).toBe(4);
	expect(bytes).toBeLessThan(fullSize * 10);
	expect(restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd).state?.revision).toBe(199);
});

test("a corrupt delta restores the preceding snapshot with an explicit warning", () => {
	const manager = SessionManager.inMemory(cwd);
	const state = newState("default", preset);
	const snapshot = encodeCheckpoint(cwd, "response", state);
	manager.appendCustomEntry(CHECKPOINT, snapshot);
	const changed = structuredClone(state); changed.revision = 1;
	const delta = encodeCheckpoint(cwd, "turn", changed, state);
	expect(delta.kind).toBe("delta");
	manager.appendCustomEntry(CHECKPOINT, { ...delta, hash: "corrupt" });
	const restored = restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd);
	expect(restored.warning).toContain("preceding valid");
	expect(restored.state?.revision).toBe(0);
});

test("restores recorded tool results after a checkpoint without duplicating the assistant or its fee", () => {
	const { manager, state, message } = fixture();
	manager.appendCustomEntry(CHECKPOINT, { version: 2, cwd, stage: "response", state });
	manager.appendMessage(message);
	manager.appendMessage({ role: "toolResult", toolCallId: "write", toolName: "write", timestamp: 1, isError: false, content: [{ type: "text", text: "changed" }] });
	const restored = restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd);
	expect(restored.warning).toBeUndefined();
	const session = new MixtureSession(preset, {} as any, restored.state!, () => ({ available: true, jobs: [] }));
	session.reconcile("test resume");
	expect(session.state.lead.messages.filter(message => message.role === "assistant")).toHaveLength(1);
	expect(session.state.lead.messages.filter(message => message.role === "toolResult")).toMatchObject([{ isError: false, toolCallId: "write" }]);
	expect(session.state.owner).toBeUndefined();
	expect(session.takeUsage().totalTokens).toBe(0);
});

test("unconfirmed calls become interrupted history and their known usage remains chargeable once", () => {
	const { manager, state } = fixture();
	manager.appendCustomEntry(CHECKPOINT, { version: 2, cwd, stage: "request", state });
	const restored = restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd);
	expect(restored.warning).toContain("usage not checkpointed remains unknown");
	const session = new MixtureSession(preset, {} as any, restored.state!, () => ({ available: true, jobs: [] }));
	session.reconcile("interrupted");
	expect(JSON.stringify(session.state.lead.messages)).toContain("never replay");
	expect(session.state.lead.messages.find(message => message.role === "toolResult")).toMatchObject({ isError: true, toolCallId: "write" });
	expect(session.takeUsage().totalTokens).toBe(9);
	expect(session.takeUsage().totalTokens).toBe(0);
});

test("tree navigation uses the active ancestor but never recharges a candidate billed on another branch", () => {
	const { manager, state, message, row } = fixture();
	message.content = [{ type: "text", text: "Stale candidate" }]; message.stopReason = "stop";
	state.final = { message, checkpoint: "held", receipt: row.id, ready: true }; row.delivery = "held"; state.origins = {};
	const ancestor = manager.appendCustomEntry(CHECKPOINT, { version: 2, cwd, stage: "response", state });
	manager.appendMessage(message);
	manager.branch(ancestor);
	const restored = restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd);
	const session = new MixtureSession(preset, {} as any, restored.state!, () => ({ available: true, jobs: [] }));
	session.reconcile("tree");
	expect(session.state.final).toBeUndefined();
	expect(session.takeUsage().totalTokens).toBe(0);
	expect(session.state.active).toBe("lead");
});

test("interrupted review queues retain their evidence with an explicit warning", () => {
	const { manager, state } = fixture();
	state.reviewers[0].status = "queued";
	state.reviewers[0].pending.push({ sequence: 1, revision: 2, content: "A completed edit result awaiting review" });
	manager.appendCustomEntry(CHECKPOINT, { version: 2, cwd, stage: "response", state });
	const restored = restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd).state!;
	expect(restored.reviewers[0].pending).toEqual([]);
	expect(restored.reviewers[0].warning).toContain("review was interrupted");
	expect(JSON.stringify(restored.reviewers[0].messages)).toContain("A completed edit result awaiting review");
	expect(JSON.stringify(restored.reviewers[0].messages)).toContain("has not been reviewed");
});

test("same-model lead and writer recovery follows the checkpoint's active role", () => {
	const same = { ...preset, writer: { ...preset.writer, model: preset.lead }, reviewers: [] };
	const manager = SessionManager.inMemory(cwd);
	const state = newState("default", same); state.initialized = true; state.active = "writer"; state.owner = "writer";
	manager.appendCustomEntry(CHECKPOINT, { version: 2, cwd, stage: "response", state });
	const message = assistant();
	manager.appendMessage(message);
	manager.appendMessage({ role: "toolResult", toolCallId: "write", toolName: "write", timestamp: 1, isError: false, content: [{ type: "text", text: "changed" }] });
	const restored = restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", same, cwd).state!;
	expect(restored.writer.messages.some(item => item.role === "assistant")).toBe(true);
	expect(restored.writer.messages.some(item => item.role === "toolResult" && item.toolCallId === "write")).toBe(true);
	expect(restored.lead.messages.some(item => item.role === "assistant")).toBe(false);
});

test("invalid, incompatible or foreign-directory checkpoints fail visibly without modifying entries", () => {
	const { manager, state } = fixture();
	manager.appendCustomEntry(CHECKPOINT, { version: 2, cwd, stage: "response", state });
	const count = manager.getEntries().length;
	expect(restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, "/other").warning).toContain("another working directory");
	expect(restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", { ...preset, lead: "other/model" }, cwd).warning).toContain("preset changed");
	expect(() => parseCheckpoint({ version: 2, cwd, stage: "response", state: { ...state, lead: { ...state.lead, usage: null } } })).toThrow("role history or usage");
	expect(manager.getEntries()).toHaveLength(count);
});

test("restoring without bg-bash blocks only unresolved tracked jobs", async () => {
	const empty = fixture().state;
	empty.bgManaged = true; empty.active = "writer"; empty.owner = "writer"; empty.delegations = 1;
	const available = new MixtureSession(preset, {} as any, empty, () => ({ sessionId: "root", available: false, jobs: [] }));
	empty.origins.takeover = { actor: "lead", synthetic: false };
	await expect(available.control("takeover", { action: "takeover" })).resolves.toBeDefined();
	expect(empty.owner).toBe("lead");

	const unresolved = fixture().state;
	unresolved.bgManaged = true; unresolved.active = "writer"; unresolved.owner = "writer"; unresolved.jobs.job1 = "writer";
	const blocked = new MixtureSession(preset, {} as any, unresolved, () => ({ sessionId: "root", available: false, jobs: [] }));
	blocked.reconcile("reload");
	unresolved.origins.takeover = { actor: "lead", synthetic: false };
	await expect(blocked.control("takeover", { action: "takeover" })).rejects.toThrow("unresolved tracked-job query");
	expect(unresolved.owner).toBe("writer");
});
