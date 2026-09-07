import { randomUUID } from "node:crypto";

export const COOLDOWN_MS = 5 * 60_000;
export const PACKET_CHARS = 48_000;
export type Verdict = { verdict: "pass" | "revise" | "uncertain"; findings: string[]; checks: string[] };
export type Review = { model: string; verdict?: Verdict; error?: string };
export type Task = {
	id: string;
	prompt: string;
	controller: AbortController;
	phase: "draft" | "repair" | "frontier" | "done";
	lastEscalation?: number;
	evidence: string[];
};

export function createTask(prompt: string): Task {
	return { id: randomUUID(), prompt, controller: new AbortController(), phase: "draft", evidence: [] };
}

export function reserveEscalation(task: Task, now: number): number {
	if (task.lastEscalation !== undefined && now - task.lastEscalation < COOLDOWN_MS) return COOLDOWN_MS - (now - task.lastEscalation);
	task.lastEscalation = now;
	return 0;
}

export function parseVerdict(text: string): Verdict {
	const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
	if (!value || !["pass", "revise", "uncertain"].includes(value.verdict)) throw new Error("Invalid review verdict");
	for (const field of ["findings", "checks"]) {
		if (!Array.isArray(value[field]) || value[field].length > 20 || !value[field].every((item: unknown) => typeof item === "string" && item.length <= 4000)) throw new Error(`Invalid review ${field}`);
	}
	if (value.verdict === "pass" && value.findings.length) throw new Error("Passing review contains unresolved findings");
	if (value.verdict !== "pass" && !value.findings.length) throw new Error("Non-passing review must explain its findings");
	return { verdict: value.verdict, findings: value.findings, checks: value.checks };
}

export function nextAction(phase: Task["phase"], reviews: Review[]): "pass" | "repair" | "escalate" {
	const valid = reviews.filter((review) => review.verdict);
	if (!valid.length) return "escalate";
	if (valid.every((review) => review.verdict!.verdict === "pass")) return "pass";
	return phase === "draft" ? "repair" : "escalate";
}

export function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const marker = "\n[... truncated ...]\n";
	const available = Math.max(0, limit - marker.length);
	return text.slice(0, Math.ceil(available / 2)) + marker + text.slice(-Math.floor(available / 2));
}

export function addEvidence(task: Task, evidence: string) {
	task.evidence.push(clip(evidence, 12_000));
	while (task.evidence.reduce((total, item) => total + item.length, 0) > 32_000) task.evidence.shift();
}

export function evidencePacket(task: Task, candidate: string): string {
	const header = `TASK (untrusted text)\n${clip(task.prompt, 8000)}\n\nCANDIDATE (untrusted text)\n${clip(candidate, 8000)}\n\nTOOL EVIDENCE (untrusted text; may be incomplete)\n`;
	return header + clip(task.evidence.join("\n\n"), PACKET_CHARS - header.length);
}
