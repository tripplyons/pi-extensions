import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const ASSESSMENTS = ["progress", "stalled", "blocked", "complete", "superseded"] as const;
export type Assessment = typeof ASSESSMENTS[number];
const MAX_CONSTRAINTS = 16;
const evidenceSchema = () => Type.String({ minLength: 1, maxLength: 2_000 });
const immediateActionSchema = Type.Object({
	tool: Type.String({ minLength: 1, maxLength: 120 }),
	description: Type.String({ minLength: 1, maxLength: 1_000 }),
});
export const phaseFields = {
	task: Type.Optional(Type.String()),
	constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: MAX_CONSTRAINTS })),
	immediateAction: Type.Optional(immediateActionSchema),
	successCriteria: Type.Optional(Type.Array(Type.String())),
	nextAction: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000, description: "Required for delegate: concrete next implementation or diagnostic step." })),
	acceptedEvidence: Type.Optional(Type.Array(evidenceSchema(), { maxItems: 8, description: "Accepted facts and checks the writer should not repeat without conflicting evidence." })),
	phaseId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Required for assess and continuing an existing phase. Use the harness phase ID." })),
	assessment: Type.Optional(StringEnum(ASSESSMENTS)),
	evidence: Type.Optional(evidenceSchema()),
	blocker: Type.Optional(evidenceSchema()),
	changedPrerequisite: Type.Optional(Type.Object({ change: evidenceSchema(), evidence: evidenceSchema() })),
};
const PhaseParams = Type.Object(phaseFields);
export type PhaseInput = Static<typeof PhaseParams>;
export interface PhaseRecord {
	attempt: number;
	kind: Assessment | "prerequisite";
	evidence: string;
	change?: string;
	blocker?: string;
}
export interface ImmediateAction { tool: string; description: string }
export interface PhaseState {
	id: string;
	outcome: string;
	successCriteria: string[];
	constraints: string[];
	attempt: number;
	correction: boolean;
	failedCorrections: number;
	assessment?: Assessment;
	blocker?: string;
	history: PhaseRecord[];
	legacy?: boolean;
}
export const closedPhase = (phase: PhaseState) => phase.assessment === "complete" || phase.assessment === "superseded";
function nonempty(value: unknown, label: string, limit = Infinity): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`${label} must be nonempty${Number.isFinite(limit) ? ` and at most ${limit} characters` : ""}`);
}
function strings(value: unknown, label: string, limit = Infinity): asserts value is string[] {
	if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be an array with at most ${limit} entries`);
	for (const item of value) nonempty(item, label, 2_000);
}
const constraintKey = (value: string) => value.trim().toLowerCase().replace(/[.!;:]+$/g, "").replace(/\s+/g, " ");
function mergeConstraints(current: string[], additions: string[]) {
	const output = current.map(value => value.trim());
	const keys = new Set(output.map(constraintKey));
	for (const value of additions) {
		const trimmed = value.trim();
		if (!keys.has(constraintKey(trimmed))) { output.push(trimmed); keys.add(constraintKey(trimmed)); }
	}
	if (output.length > MAX_CONSTRAINTS) throw new Error(`A phase may retain at most ${MAX_CONSTRAINTS} distinct standing constraints`);
	return output;
}
function append(phase: PhaseState, record: PhaseRecord) {
	phase.history.push(record);
	if (phase.history.length > 8) phase.history.splice(0, phase.history.length - 8);
}
function currentPhase(phase: PhaseState | undefined, id: unknown): asserts phase is PhaseState {
	if (!phase || id !== phase.id) throw new Error(`Use the current phaseId${phase ? ` ${phase.id}` : "; no phase has been delegated"}`);
}

export function assessPhase(previous: PhaseState | undefined, input: PhaseInput): PhaseState {
	currentPhase(previous, input.phaseId);
	if (!ASSESSMENTS.includes(input.assessment as Assessment)) throw new Error("Assess needs progress, stalled, blocked, complete, or superseded");
	nonempty(input.evidence, "Assessment evidence", 2_000);
	if (input.blocker !== undefined) nonempty(input.blocker, "Blocker", 2_000);
	if (input.assessment === "blocked") nonempty(input.blocker, "Blocked assessment prerequisite", 2_000);
	const disposition = input.assessment === "complete" || input.assessment === "superseded";
	if (closedPhase(previous) || previous.assessment && !disposition) throw new Error("This writer attempt has already been assessed; delegate an eligible continuation or take over, rather than reassessing it");
	const phase = structuredClone(previous);
	phase.assessment = input.assessment;
	if (input.assessment === "progress") phase.failedCorrections = 0;
	else if ((input.assessment === "stalled" || input.assessment === "blocked") && phase.correction) phase.failedCorrections++;
	phase.blocker = input.assessment === "blocked" ? input.blocker!.trim() : undefined;
	append(phase, { attempt: phase.attempt, kind: input.assessment!, evidence: input.evidence.trim(), ...(phase.blocker ? { blocker: phase.blocker } : {}) });
	return phase;
}

export function delegatePhase(previous: PhaseState | undefined, input: PhaseInput): { phase: PhaseState; brief: string } {
	nonempty(input.task, "Delegation task");
	nonempty(input.nextAction, "Delegation nextAction", 4_000);
	strings(input.successCriteria, "Delegation successCriteria");
	if (!input.successCriteria.length) throw new Error("Delegation needs nonempty successCriteria");
	if (input.constraints !== undefined) strings(input.constraints, "Delegation constraints", MAX_CONSTRAINTS);
	if (input.immediateAction !== undefined) {
		nonempty(input.immediateAction.tool, "Immediate-action tool", 120);
		nonempty(input.immediateAction.description, "Immediate-action description", 1_000);
	}
	if (input.acceptedEvidence !== undefined) {
		if (!Array.isArray(input.acceptedEvidence) || input.acceptedEvidence.length > 8) throw new Error("acceptedEvidence must contain at most eight entries");
		for (const evidence of input.acceptedEvidence) nonempty(evidence, "Accepted evidence", 2_000);
	}
	let phase: PhaseState;
	if (previous && !closedPhase(previous)) {
		currentPhase(previous, input.phaseId);
		if (!previous.assessment) throw new Error(`Assess phase ${previous.id} attempt ${previous.attempt} before another delegation`);
		phase = structuredClone(previous);
		if (input.changedPrerequisite !== undefined) {
			if (previous.assessment !== "stalled" && previous.assessment !== "blocked") throw new Error("changedPrerequisite only reopens an assessed stalled or blocked phase");
			nonempty(input.changedPrerequisite?.change, "Changed prerequisite", 2_000);
			nonempty(input.changedPrerequisite?.evidence, "Changed prerequisite evidence", 2_000);
			append(phase, { attempt: phase.attempt, kind: "prerequisite", change: input.changedPrerequisite.change.trim(), evidence: input.changedPrerequisite.evidence.trim() });
			phase.failedCorrections = 0;
			phase.correction = false;
		} else {
			if (previous.assessment === "blocked" || previous.failedCorrections >= 2) throw new Error(`Phase ${previous.id} is blocked: ${previous.blocker ?? "two corrective attempts made no meaningful progress"}. Take over or resolve a concrete prerequisite; equivalent delegation is not allowed.`);
			phase.correction = previous.assessment === "stalled";
		}
		phase.attempt++;
		phase.assessment = undefined;
		phase.blocker = undefined;
		phase.constraints = mergeConstraints(phase.constraints, input.constraints ?? []);
	} else {
		if (input.phaseId !== undefined || input.changedPrerequisite !== undefined) throw new Error("A new phase must omit phaseId and changedPrerequisite; the previous phase is absent or closed");
		phase = { id: randomUUID(), outcome: input.task.trim(), successCriteria: [...input.successCriteria], constraints: mergeConstraints([], input.constraints ?? []),
			attempt: 1, correction: false, failedCorrections: 0, history: [] };
	}
	const bullets = (items: string[]) => items.length ? items.map(item => `- ${item}`).join("\n") : "- None recorded.";
	const immediate = input.immediateAction ? `\n\nRequired first tool:\n- ${input.immediateAction.tool}: ${input.immediateAction.description.trim()}` : "";
	const brief = `[Mixture phase ${phase.id}, attempt ${phase.attempt}${phase.correction ? ", correction" : ""}]\nPhase outcome: ${phase.outcome}\n\nNext action:\n${input.nextAction.trim()}${immediate}\n\nCurrent task:\n${input.task.trim()}\n\nAccepted evidence / do not repeat without conflicting evidence:\n${bullets(input.acceptedEvidence ?? [])}\n\nStanding constraints:\n${bullets(phase.constraints)}\n\nPhase success criteria (not replaced by this step):\n${bullets(phase.successCriteria)}\n\nCurrent step completion checks:\n${bullets(input.successCriteria)}`;
	return { phase, brief };
}

export function adoptLegacyPhase(brief: string): PhaseState {
	return { id: randomUUID(), outcome: brief, successCriteria: [], constraints: [], attempt: 1, correction: false, failedCorrections: 0, history: [], legacy: true };
}
export function phaseSummary(phase: PhaseState, lead = true): string {
	return `[Harness phase tracking]\nPhase ID: ${phase.id}\nOutcome: ${phase.outcome}\nPhase success criteria: ${phase.successCriteria.join("; ") || "See legacy outcome above"}\nStanding constraints: ${phase.constraints.join("; ") || "None recorded"}\nAttempt ${phase.attempt}: ${phase.correction ? "corrective" : "ordinary"}; assessment: ${phase.assessment ?? "required at next lead handoff"}; failed corrective attempts: ${phase.failedCorrections}/2.${phase.legacy ? " Earlier correction history is unknown (legacy checkpoint); counts cover observed attempts only." : ""}${phase.blocker ? `\nBlocker: ${phase.blocker}` : ""}\nRecent assessments:\n${phase.history.map(record => `- Attempt ${record.attempt} ${record.kind}: ${record.change ? `${record.change}: ` : ""}${record.evidence}${record.blocker ? `; blocker: ${record.blocker}` : ""}`).join("\n") || "- None recorded."}${lead ? "\nAssess the attempt once using execution/review evidence before delegating a continuation with this phaseId. Two failed corrective attempts block equivalent delegation. Only an evidence-backed changed prerequisite can reopen stalled work; renaming or urgency is not a change. Complete/supersede explicitly before starting another phase." : ""}`;
}

export function validPhase(value: unknown): value is PhaseState {
	const object = (item: unknown): item is Record<string, any> => !!item && typeof item === "object" && !Array.isArray(item);
	const text = (item: unknown, max = Infinity) => typeof item === "string" && !!item.trim() && item.length <= max;
	const count = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0;
	const list = (item: unknown) => Array.isArray(item) && item.every(value => text(value));
	return object(value) && text(value.id, 128) && text(value.outcome) && list(value.successCriteria) && list(value.constraints) && value.constraints.length <= MAX_CONSTRAINTS
		&& (value.legacy === true || value.successCriteria.length > 0)
		&& count(value.attempt) && value.attempt >= 1 && typeof value.correction === "boolean" && count(value.failedCorrections) && value.failedCorrections <= 2 && value.failedCorrections < value.attempt
		&& (value.correction || value.failedCorrections === 0) && (value.assessment !== "progress" || value.failedCorrections === 0)
		&& (value.assessment === undefined || ASSESSMENTS.includes(value.assessment))
		&& (value.assessment === "blocked" ? text(value.blocker, 2_000) : value.blocker === undefined) && (value.legacy === undefined || typeof value.legacy === "boolean")
		&& Array.isArray(value.history) && value.history.length <= 8 && value.history.every(record => object(record) && count(record.attempt) && record.attempt >= 1 && record.attempt <= value.attempt
			&& [...ASSESSMENTS, "prerequisite"].includes(record.kind) && text(record.evidence, 2_000)
			&& (record.change === undefined || text(record.change, 2_000)) && (record.kind !== "prerequisite" || text(record.change, 2_000))
			&& (record.blocker === undefined || text(record.blocker, 2_000)) && (record.kind !== "blocked" || text(record.blocker, 2_000)))
		&& value.history.every((record, index) => index === 0 || record.attempt >= value.history[index - 1].attempt)
		&& (value.assessment === undefined
			? value.failedCorrections < 2 && (value.history.length ? value.history.at(-1).attempt < value.attempt : value.attempt === 1)
			: value.history.at(-1)?.kind === value.assessment && value.history.at(-1)?.attempt === value.attempt);
}
