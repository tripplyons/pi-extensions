import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT, encodeCheckpoint, materializeCheckpoint, parseCheckpoint, restoreCheckpoint } from "./checkpoint.ts";
import { defaultConfig } from "./config.ts";
import { assessPhase, delegatePhase, type PhaseState } from "./phase.ts";
import { MixtureSession, newState } from "./session.ts";

const cwd = process.cwd();
const preset = defaultConfig().presets.default;
const brief = { task: "Fix cancellation", nextAction: "Verify the signal reaches the child", successCriteria: ["Child stops", "Persistent jobs survive"] };
const assessed = (phase: PhaseState) => assessPhase(phase, { phaseId: phase.id, assessment: "stalled", evidence: "Repeated source search did not resolve the cancellation failure" });
function stalledPhase() {
	let phase = delegatePhase(undefined, brief).phase;
	for (let index = 0; index < 2; index++) phase = delegatePhase(assessed(phase), { ...brief, phaseId: phase.id }).phase;
	return assessed(phase);
}

test("snapshot and delta round trips preserve an exhausted phase exactly", () => {
	const manager = SessionManager.inMemory(cwd);
	const before = newState("default", preset);
	before.lead.messages.push({ role: "user", content: "x".repeat(20_000), timestamp: 1 });
	before.phase = delegatePhase(undefined, brief).phase;
	manager.appendCustomEntry(CHECKPOINT, encodeCheckpoint(cwd, "turn", before));
	const after = structuredClone(before); after.phase = stalledPhase();
	const delta = encodeCheckpoint(cwd, "turn", after, before);
	expect(delta.kind).toBe("delta");
	manager.appendCustomEntry(CHECKPOINT, delta);
	const restored = restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd);
	expect(restored.warning).toBeUndefined();
	expect(restored.state?.phase).toEqual(after.phase);
	expect(() => delegatePhase(restored.state!.phase, { ...brief, phaseId: after.phase.id })).toThrow("two corrective attempts");
});

test("legacy snapshots retain their hash and adopt only unknown historical progress", () => {
	for (const version of [2, 3]) {
		const state = newState("default", preset);
		state.brief = "Task: Continue legacy work\nConstraints: Preserve human edits";
		const stored = version === 2 ? { version: 2, cwd, stage: "idle", state } : encodeCheckpoint(cwd, "idle", state);
		const serialized = JSON.stringify(stored);
		const parsed = parseCheckpoint(stored);
		expect(parsed.state.phase).toBeUndefined();
		expect(JSON.stringify(stored)).toBe(serialized);
		const session = new MixtureSession(preset, {} as any, parsed.state, () => ({ available: true, jobs: [] }));
		expect(session.state.phase).toMatchObject({ outcome: state.brief, legacy: true, failedCorrections: 0 });
		expect(session.state.phase!.assessment).toBeUndefined();
		expect(session.state.phase!.history).toEqual([]);
		expect(parseCheckpoint(encodeCheckpoint(cwd, "idle", session.state)).state.phase).toEqual(session.state.phase);
	}
});

test("malformed phase payloads are rejected and corrupt deltas cannot erase a stall", () => {
	const state = newState("default", preset); state.phase = stalledPhase();
	for (const patch of [{ attempt: 0 }, { failedCorrections: -1 }, { failedCorrections: 3 }, { correction: "true" }, { assessment: "maybe" }, { history: Array(9).fill(state.phase.history[0]) }, { history: [{ attempt: 1, kind: "stalled", evidence: " " }] }, { history: [{ attempt: 1, kind: "prerequisite", evidence: "Authorized" }] }, { blocker: "x".repeat(2_001) }, { successCriteria: [false] }, { id: "" }]) {
		expect(() => parseCheckpoint({ version: 2, cwd, stage: "idle", state: { ...state, phase: { ...state.phase, ...patch } } })).toThrow("phase tracking");
	}
	const manager = SessionManager.inMemory(cwd);
	manager.appendCustomEntry(CHECKPOINT, encodeCheckpoint(cwd, "idle", state));
	const after = structuredClone(state); after.phase!.failedCorrections = 0;
	const delta = encodeCheckpoint(cwd, "turn", after, state);
	manager.appendCustomEntry(CHECKPOINT, { ...delta, hash: "bad" });
	const restored = materializeCheckpoint(manager.getBranch());
	expect(restored.warning).toBeDefined();
	expect(restored.checkpoint?.state.phase).toEqual(state.phase);
});

test("branch restoration uses the selected phase history, not a future resolution", () => {
	const manager = SessionManager.inMemory(cwd);
	const state = newState("default", preset); state.phase = stalledPhase();
	const ancestor = manager.appendCustomEntry(CHECKPOINT, encodeCheckpoint(cwd, "idle", state));
	const resolved = structuredClone(state);
	resolved.phase = delegatePhase(state.phase, { ...brief, phaseId: state.phase.id, changedPrerequisite: { change: "Missing dependency installed", evidence: "Version command now succeeds" } }).phase;
	manager.appendCustomEntry(CHECKPOINT, encodeCheckpoint(cwd, "turn", resolved, state));
	manager.branch(ancestor);
	const restored = restoreCheckpoint(manager.getBranch(), manager.getEntries(), "default", preset, cwd);
	expect(restored.state?.phase).toEqual(state.phase);
	expect(restored.state?.phase?.failedCorrections).toBe(2);
});

test("abort, reconciliation, request reset and lead compaction retain the machine-owned phase", async () => {
	const state = newState("default", preset); state.phase = stalledPhase();
	const before = structuredClone(state.phase);
	const session = new MixtureSession(preset, {} as any, state, () => ({ available: true, jobs: [] }));
	await session.abort();
	session.reconcile("session restored");
	session.newRequest("Keep going");
	session.rebaseLeadAfterCompaction("root-compaction");
	expect(state.phase).toEqual(before);
	expect(state.delegations).toBe(0);
	state.origins.retry = { actor: "lead", synthetic: false };
	await expect(session.control("retry", { action: "delegate", ...brief, phaseId: before.id })).rejects.toThrow("two corrective attempts");
	expect(state.owner).toBeUndefined();
});
