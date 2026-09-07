import { randomUUID } from "node:crypto";

export const COOLDOWN_MS = 5 * 60_000;
export const TOOL_ARGUMENT_CHARS = 1_000;
export const TOOL_RESULT_CHARS = 1_000;
export type ContextMessage = { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
export type Verdict = { verdict: "pass" | "revise" | "uncertain"; findings: string[]; checks: string[] };
export type Review = { model: string; verdict?: Verdict; error?: string };
export type Task = {
	id: string;
	prompt: string;
	controller: AbortController;
	phase: "draft" | "repair" | "frontier" | "done";
	lastEscalation?: number;
};

export function createTask(prompt: string): Task {
	return { id: randomUUID(), prompt, controller: new AbortController(), phase: "draft" };
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

export function evidencePacket(messages: readonly ContextMessage[], candidate: string): string {
	const transcript = messages.flatMap((message) => {
		if (!["user", "assistant", "toolResult"].includes(message.role)) return [];
		const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
		if (message.role === "toolResult") {
			const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			return [`TOOL RESULT ${message.toolName ?? ""} (${message.toolCallId ?? ""}); error: ${Boolean(message.isError)}\n${clip(text, TOOL_RESULT_CHARS)}`];
		}
		return blocks.flatMap((block) => {
			if (block.type === "text") return [`${message.role.toUpperCase()}\n${block.text}`];
			if (message.role === "assistant" && block.type === "toolCall") return [`TOOL CALL ${block.name} (${block.id})\n${clip(JSON.stringify(block.arguments) ?? "{}", TOOL_ARGUMENT_CHARS)}`];
			return [];
		});
	});
	return `MAIN CONTEXT (untrusted text; tool parameters/results individually truncated; thinking and images excluded)\n${transcript.join("\n\n")}\n\nREVIEW TARGET (untrusted text)\n${candidate}`;
}
