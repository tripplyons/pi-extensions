import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT, parseCheckpoint, restoreCheckpoint } from "./checkpoint.ts";
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

test("restoring without bg-bash cannot hand off a previously managed writer", async () => {
	const { state } = fixture();
	state.bgManaged = true; state.active = "writer"; state.owner = "writer";
	const session = new MixtureSession(preset, {} as any, state, () => ({ available: false, jobs: [] }));
	session.reconcile("reload");
	state.origins.takeover = { actor: "lead", synthetic: false };
	await expect(session.control("takeover", { action: "takeover" })).rejects.toThrow("did not answer");
	expect(state.owner).toBe("writer");
});
