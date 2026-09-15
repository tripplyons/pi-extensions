import { expect, test } from "bun:test";
import { defaultConfig } from "./config.ts";
import { assessPhase, delegatePhase, phaseSummary, recordPhaseUpdate, validPhase, type PhaseState } from "./phase.ts";
import { MixtureSession, newState, type ControlInput } from "./session.ts";

const brief = { task: "Fix the foreground interrupt", nextAction: "Test the cancellation signal at the process boundary", constraints: ["Persistent jobs must survive"], successCriteria: ["Foreground child terminates", "Persistent job survives"] };
const assess = (phase: PhaseState, assessment: "progress" | "stalled" | "blocked" = "stalled") => assessPhase(phase, {
	phaseId: phase.id, assessment, evidence: assessment === "progress" ? "The process trace locates the missing abort subscription" : "The writer repeated the same source search; no uncertainty was resolved",
	...(assessment === "blocked" ? { blocker: "Need authorization to change the protected deadline" } : {}),
});
const continuation = (phase: PhaseState) => delegatePhase(phase, { ...brief, phaseId: phase.id }).phase;
function exhausted() {
	let phase = delegatePhase(undefined, brief).phase;
	phase = continuation(assess(phase));
	phase = continuation(assess(phase));
	return assess(phase);
}

test("initial stall permits two corrections but never a third equivalent correction", () => {
	let phase = delegatePhase(undefined, brief).phase;
	expect(phase).toMatchObject({ attempt: 1, correction: false, failedCorrections: 0 });
	phase = continuation(assess(phase));
	expect(phase).toMatchObject({ attempt: 2, correction: true, failedCorrections: 0 });
	phase = continuation(assess(phase));
	expect(phase).toMatchObject({ attempt: 3, correction: true, failedCorrections: 1 });
	phase = assess(phase);
	expect(phase).toMatchObject({ attempt: 3, assessment: "stalled", failedCorrections: 2 });
	const before = structuredClone(phase);
	for (let retry = 0; retry < 3; retry++) expect(() => continuation(phase)).toThrow("two corrective attempts");
	expect(phase).toEqual(before);
	expect(() => delegatePhase(phase, { ...brief, task: "Finish NOW" })).toThrow("current phaseId");
	expect(() => assess(phase, "progress")).toThrow("already been assessed");
});

test("read-only progress is a lead evidence decision, not inferred from tools or mutations", () => {
	let phase = continuation(assess(delegatePhase(undefined, brief).phase));
	phase = assess(phase, "progress");
	expect(phase.failedCorrections).toBe(0);
	expect(phase.history.at(-1)?.evidence).toContain("process trace");
	phase = continuation(phase);
	expect(phase.correction).toBe(false);
	phase = continuation(assess(phase));
	expect(phase).toMatchObject({ correction: true, failedCorrections: 0 });
});

test("blocked work needs a changed prerequisite; reopening keeps its identity and history", () => {
	for (const phase of [exhausted(), assess(delegatePhase(undefined, brief).phase, "blocked")]) {
		expect(() => continuation(phase)).toThrow("blocked");
		expect(() => delegatePhase(phase, { ...brief, phaseId: phase.id, changedPrerequisite: { change: "", evidence: "Approved" } })).toThrow("Changed prerequisite");
		const reopened = delegatePhase(phase, { ...brief, phaseId: phase.id, changedPrerequisite: { change: "User authorized timing-only deadline revision", evidence: "Approval recorded in the latest user answer" } }).phase;
		expect(reopened).toMatchObject({ id: phase.id, failedCorrections: 0, correction: false, attempt: phase.attempt + 1 });
		expect(reopened.assessment).toBeUndefined();
		expect(reopened.blocker).toBeUndefined();
		expect(reopened.history).toHaveLength(phase.history.length + 1);
		expect(validPhase(reopened)).toBe(true);
	}
});

test("a blocked corrective attempt retains its failed-correction count", () => {
	const initial = delegatePhase(undefined, brief).phase;
	const correction = continuation(assess(initial));
	const blocked = assess(correction, "blocked");
	expect(blocked).toMatchObject({ assessment: "blocked", failedCorrections: 1 });
	expect(validPhase(blocked)).toBe(true);
	expect(() => continuation(blocked)).toThrow("Need authorization");
	expect(() => assess(blocked, "progress")).toThrow("already been assessed");
});

test("phase disposition is explicit and a smaller step preserves original acceptance", () => {
	const initial = delegatePhase(undefined, brief).phase;
	expect(() => continuation(initial)).toThrow("Assess phase");
	const progressed = assess(initial, "progress");
	const next = delegatePhase(progressed, { ...brief, phaseId: initial.id, task: "Write just the signal regression", constraints: ["Do not install"], successCriteria: ["Regression fails against old implementation"], acceptedEvidence: ["The abort handler is missing"] });
	expect(next.phase.outcome).toBe(brief.task);
	expect(next.phase.successCriteria).toEqual(brief.successCriteria);
	expect(next.brief).toContain("Persistent jobs must survive");
	expect(next.brief).toContain("Do not install");
	expect(next.brief).toContain("Foreground child terminates");
	expect(next.brief).toContain("Regression fails against old implementation");
	expect(next.brief).toContain("Accepted evidence / do not repeat");
	for (const assessment of ["complete", "superseded"] as const) {
		const closed = assessPhase(progressed, { phaseId: initial.id, assessment, evidence: assessment === "complete" ? "Lead takeover passed both behavior checks" : "User explicitly replaced this request" });
		expect(() => assessPhase(closed, { phaseId: initial.id, assessment, evidence: "Again" })).toThrow("already been assessed");
		const fresh = delegatePhase(closed, brief).phase;
		expect(fresh.id).not.toBe(initial.id);
		expect(fresh.attempt).toBe(1);
	}
});

test("history stays bounded independently of counting", () => {
	let phase = delegatePhase(undefined, brief).phase;
	for (let attempt = 0; attempt < 20; attempt++) phase = continuation(assess(phase, "progress"));
	phase = continuation(assess(phase));
	phase = continuation(assess(phase));
	phase = assess(phase);
	expect(phase.history).toHaveLength(8);
	expect(phase.failedCorrections).toBe(2);
	expect(() => continuation(phase)).toThrow("two corrective attempts");
	expect(phaseSummary(phase)).toContain("failed corrective attempts: 2/2");
	expect(validPhase(phase)).toBe(true);
});

test("standing constraints are canonicalized, deduplicated and bounded", () => {
	let phase = delegatePhase(undefined, { ...brief, constraints: ["  Preserve human edits.  "] }).phase;
	phase = delegatePhase(assess(phase, "progress"), { ...brief, phaseId: phase.id, constraints: ["preserve   human edits", "Do not install dependencies"] }).phase;
	expect(phase.constraints).toEqual(["Preserve human edits.", "Do not install dependencies"]);
	const full = delegatePhase(undefined, { ...brief, constraints: Array.from({ length: 16 }, (_, index) => `Constraint ${index}`) }).phase;
	expect(() => delegatePhase(assess(full, "progress"), { ...brief, phaseId: full.id, constraints: ["Seventeenth distinct constraint"] })).toThrow("at most 16");
});

test("lead updates are bounded phase records rather than standing constraints", () => {
	let phase = delegatePhase(undefined, brief).phase;
	const constraints = structuredClone(phase.constraints);
	for (let index = 0; index < 12; index++) phase = recordPhaseUpdate(phase, `Direction ${index}`);
	expect(phase.constraints).toEqual(constraints);
	expect(phase.updates).toHaveLength(8);
	expect(phase.updates?.[0]).toEqual({ attempt: 1, message: "Direction 4" });
	expect(validPhase(phase)).toBe(true);
	const next = delegatePhase(assess(phase, "progress"), { ...brief, phaseId: phase.id });
	expect(next.brief).toContain("Lead updates during this phase:");
	expect(next.brief).toContain("Attempt 1: Direction 11");
	expect(next.phase.constraints).toEqual(constraints);
	expect(() => recordPhaseUpdate(phase, "x".repeat(4_001))).toThrow("at most 4000 characters");
});

test("an immediate action appears in only its delegated attempt", () => {
	const initial = delegatePhase(undefined, { ...brief, immediateAction: { tool: "bash", description: "Run the exact reproduction before source exploration" } });
	expect(initial.brief).toContain("Required first tool:\n- bash: Run the exact reproduction");
	const next = delegatePhase(assess(initial.phase, "progress"), { ...brief, phaseId: initial.phase.id });
	expect(next.brief).not.toContain("Required first tool");
});

test("missing, malformed, and oversized fields fail without mutating phase state", () => {
	const phase = delegatePhase(undefined, brief).phase;
	const before = structuredClone(phase);
	for (const extra of [{ nextAction: "" }, { nextAction: "x".repeat(4_001) }, { acceptedEvidence: [" "] }, { acceptedEvidence: Array(9).fill("Fact") }, { acceptedEvidence: ["x".repeat(2_001)] }, { constraints: Array(17).fill("Constraint") }, { immediateAction: { tool: "", description: "Run it" } }, { successCriteria: [] }]) {
		expect(() => delegatePhase(undefined, { ...brief, ...extra })).toThrow();
	}
	for (const extra of [{ phaseId: "wrong" }, { evidence: " " }, { evidence: "x".repeat(2_001) }, { assessment: "blocked" as const }]) {
		expect(() => assessPhase(phase, { phaseId: phase.id, assessment: "stalled", evidence: "No progress", ...extra })).toThrow();
	}
	expect(phase).toEqual(before);
});

test("continuations require every current-step delegation field without mutating phase state", () => {
	const initial = delegatePhase(undefined, brief).phase;
	const progressed = assess(initial, "progress");
	const before = structuredClone(progressed);
	for (const extra of [
		{ task: undefined }, { task: " " }, { nextAction: undefined }, { nextAction: " " },
		{ successCriteria: undefined }, { successCriteria: [] }, { successCriteria: [""] }, { successCriteria: [" "] },
	]) {
		expect(() => delegatePhase(progressed, { ...brief, phaseId: progressed.id, ...extra })).toThrow("Delegation");
	}
	expect(() => delegatePhase(progressed, brief)).toThrow("current phaseId");
	expect(() => delegatePhase(progressed, { ...brief, phaseId: "wrong" })).toThrow("current phaseId");
	expect(progressed).toEqual(before);
});

test("real control transitions persist assessment before blocked delegation and retain takeover", async () => {
	const preset = defaultConfig().presets.default; preset.reviewers = [];
	const state = newState("default", preset);
	let changes = 0;
	const jobs = { available: true, jobs: [] as any[] };
	const session = new MixtureSession(preset, {} as any, state, () => jobs, () => changes++);
	let calls = 0;
	const control = (input: ControlInput, actor: "lead" | "writer" = "lead") => {
		const id = `control-${++calls}`;
		state.origins[id] = { actor, synthetic: false };
		return session.control(id, input);
	};
	await control({ action: "delegate", ...brief });
	for (let attempt = 0; attempt < 3; attempt++) {
		await expect(control({ action: "assess", phaseId: state.phase!.id, assessment: "stalled", evidence: "No progress" }, "writer")).rejects.toThrow("Only the lead");
		await expect(control({ action: "assess", phaseId: state.phase!.id, assessment: "stalled", evidence: "No progress" })).rejects.toThrow("retains its lease");
		await control({ action: "report", report: "Only repeated research; no useful new evidence" }, "writer");
		await control({ action: "assess", phaseId: state.phase!.id, assessment: "stalled", evidence: "Same search output, no new evidence" });
		if (attempt < 2) await control({ action: "delegate", ...brief, phaseId: state.phase!.id });
	}
	expect(state.phase!.failedCorrections).toBe(2);
	const before = structuredClone(state.phase);
	const changedBefore = changes;
	await expect(control({ action: "delegate", ...brief, phaseId: state.phase!.id })).rejects.toThrow("two corrective attempts");
	expect(changes).toBe(changedBefore);
	expect(state.phase).toEqual(before);
	expect(state.owner).toBeUndefined();
	session.newRequest("Continue the same goal");
	expect(state.phase).toEqual(before);
	jobs.jobs.push({ id: "persistent", status: "running" });
	await expect(control({ action: "takeover" })).rejects.toThrow("persistent");
	jobs.jobs = [];
	await control({ action: "takeover" });
	expect(state.owner).toBe("lead");
	expect(state.phase).toEqual(before);
});
