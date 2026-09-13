import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { defaultConfig } from "./config.ts";
import { abortable, emptyUsage } from "./provider.ts";
import { executionDelta, newReviewer, ReviewPool } from "./review.ts";

const reply = (name: string, args: Record<string, unknown>): AssistantMessage => ({ role: "assistant", provider: "fixture", model: "reviewer", api: "fixture", timestamp: 1,
	content: [{ type: "toolCall", id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args }], stopReason: "toolUse", usage: emptyUsage() });
const report = (revision: number, findings: Record<string, unknown>[] = []) => reply("mixture_review", { revision, findings });
const issue = { id: "missing-check", severity: "concern", summary: "Missing negative-input check", path: "fixture.txt", evidence: "negative input is accepted" };
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
};

test("reviewers run concurrently, serialize their own requests and reconfirm coalesced findings", async () => {
	const preset = defaultConfig().presets.default;
	preset.reviewers.push({ model: "fixture/second-reviewer", thinking: "low" });
	const states = preset.reviewers.map(newReviewer);
	const requests: Array<{ index: number; context: Context; result: ReturnType<typeof deferred<AssistantMessage>> }> = [];
	const active = [0, 0]; const peak = [0, 0];
	let wake: (() => void) | undefined;
	const pool = new ReviewPool(preset, states, process.cwd(), async (index, context, signal) => {
		active[index]++; peak[index] = Math.max(peak[index], active[index]);
		const result = deferred<AssistantMessage>(); requests.push({ index, context: JSON.parse(JSON.stringify(context)), result }); wake?.();
		try { return await abortable(result.promise, signal); } finally { active[index]--; }
	}, () => true);
	const untilRequests = async (count: number) => { if (requests.length >= count) return; await new Promise<void>(resolve => { wake = () => { if (requests.length >= count) resolve(); }; }); };
	try {
		pool.enqueue(1, "Execution one");
		expect(active).toEqual([1, 1]);
		pool.enqueue(2, "Execution two");
		expect(requests).toHaveLength(2);
		for (const request of requests) request.result.resolve(report(1, [issue]));
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(requests).toHaveLength(2);
		expect(pool.serious).toHaveLength(2);
		const checkpoint = pool.checkpoint(2, "Confirm the result");
		await untilRequests(4);
		for (const request of requests.slice(2)) {
			expect(JSON.stringify(request.context.messages)).toContain("Execution two");
			request.result.resolve(report(2));
		}
		const result = await checkpoint;
		expect(result.findings).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(peak).toEqual([1, 1]);
		for (const request of requests) expect(request.context.tools?.map(tool => tool.name).sort()).toEqual(["find", "grep", "ls", "mixture_review", "read"]);
	} finally { await pool.freeze(); }
});

test("primed evidence coalesces until an explicit review trigger", async () => {
	const preset = defaultConfig().presets.default; preset.reviewers = preset.reviewers.slice(0, 1);
	const states = [newReviewer()];
	const requests: Array<{ context: Context; result: ReturnType<typeof deferred<AssistantMessage>> }> = [];
	const pool = new ReviewPool(preset, states, process.cwd(), async (_index, context, signal) => {
		const result = deferred<AssistantMessage>(); requests.push({ context: structuredClone(context), result });
		return abortable(result.promise, signal);
	}, () => true);
	try {
		pool.prime(0, "Initial delegation");
		expect(requests).toHaveLength(0);
		pool.enqueue(1, "Native edit completed");
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests[0].context.messages)).toContain("Initial delegation");
		pool.prime(2, "Tests passed after the edit");
		requests[0].result.resolve(report(1));
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(requests).toHaveLength(1);
		const checkpoint = pool.checkpoint(2, "Final writer report");
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1].context.messages)).toContain("Tests passed after the edit");
		requests[1].result.resolve(report(2));
		expect((await checkpoint).warnings).toEqual([]);
		const candidate = pool.checkpoint(2, "Lead final-answer candidate", undefined, undefined, true);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(requests).toHaveLength(3);
		expect(requests[2].context.tools?.map(tool => tool.name)).toEqual(["mixture_review"]);
		requests[2].result.resolve(report(2));
		expect((await candidate).warnings).toEqual([]);
	} finally { await pool.freeze(); }
});

test("native read-only tools inspect files and preserve tool-call/result pairs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-review-"));
	const preset = defaultConfig().presets.default; preset.reviewers = preset.reviewers.slice(0, 1);
	const states = [newReviewer()];
	let count = 0;
	const pool = new ReviewPool(preset, states, dir, async (_index, context) => {
		count++;
		if (count === 1) return reply("read", { path: "fixture.txt" });
		expect(JSON.stringify(context.messages)).toContain("before\\nafter");
		expect(context.tools?.map(tool => tool.name)).toEqual(["mixture_review"]);
		return report(3, [issue]);
	}, () => true);
	try {
		writeFileSync(join(dir, "fixture.txt"), "before\nafter\n");
		const result = await pool.checkpoint(3, "Check negative input handling");
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]).toMatchObject({ model: preset.reviewers[0].model, revision: 3, id: "missing-check" });
		expect(readFileSync(join(dir, "fixture.txt"), "utf8")).toBe("before\nafter\n");
		expect(states[0].messages.filter(message => message.role === "toolResult")).toHaveLength(2);
	} finally { await pool.freeze(); rmSync(dir, { recursive: true, force: true }); }
});

test("forbidden tool calls fail before mutation and do not clear existing concerns", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-review-denied-"));
	const preset = defaultConfig().presets.default; preset.reviewers = preset.reviewers.slice(0, 1);
	const states = [newReviewer()];
	let requests = 0;
	const pool = new ReviewPool(preset, states, dir, async () => ++requests === 1 ? report(1, [issue]) : reply("write", { path: "fixture.txt", content: "bad" }), () => true);
	try {
		writeFileSync(join(dir, "fixture.txt"), "preserve\n");
		await pool.checkpoint(1, "First check");
		const result = await pool.checkpoint(2, "Reconfirm");
		expect(result.warnings.join("\n")).toContain("forbidden tool: write");
		expect(result.findings[0].revision).toBe(1);
		expect(readFileSync(join(dir, "fixture.txt"), "utf8")).toBe("preserve\n");
	} finally { await pool.freeze(); rmSync(dir, { recursive: true, force: true }); }
});

test("deadline freezes late reviews without cancelling healthy results or calling failure clean", async () => {
	const preset = defaultConfig().presets.default; preset.limits.catchUpMs = 20;
	preset.reviewers.push({ model: "fixture/late-reviewer", thinking: "low" });
	const states = preset.reviewers.map(newReviewer);
	const late = deferred<AssistantMessage>();
	const pool = new ReviewPool(preset, states, process.cwd(), async (index, _context, signal) => index === 0 ? report(7, [issue]) : abortable(late.promise, signal), () => true);
	try {
		const result = await pool.checkpoint(7, "Final answer candidate");
		expect(result.findings).toHaveLength(1);
		expect(result.warnings.join("\n")).toContain(preset.reviewers[1].model);
		expect(result.warnings.join("\n")).toContain("deadline");
		late.resolve(report(7, [{ ...issue, id: "late", severity: "blocker" }]));
		await late.promise;
		expect(pool.findings).toHaveLength(1);
		expect(pool.findings.some(finding => finding.id === "late")).toBe(false);
		expect(states[1].status).toBe("incomplete");
	} finally { await pool.freeze(); }
});

test("a failed review batch does not disable later checkpoints", async () => {
	const preset = defaultConfig().presets.default; preset.reviewers = preset.reviewers.slice(0, 1);
	const states = [newReviewer()]; let calls = 0;
	const pool = new ReviewPool(preset, states, process.cwd(), async () => ++calls === 1 ? report(99) : report(2), () => true);
	try {
		expect((await pool.checkpoint(1, "Check")).warnings.join("\n")).toContain("does not match");
		expect((await pool.checkpoint(2, "Check again")).warnings).toEqual([]);
		expect(calls).toBe(2);
		expect(states[0].requestCalls).toBe(2);
	} finally { await pool.freeze(); }
});

test("an empty optional incomplete reason does not invalidate a completed report", async () => {
	const preset = defaultConfig().presets.default;
	const states = [newReviewer()];
	const pool = new ReviewPool(preset, states, process.cwd(), async () => reply("mixture_review", { revision: 1, findings: [], incompleteReason: "" }), () => true);
	try {
		expect((await pool.checkpoint(1, "Check")).warnings).toEqual([]);
		expect(states[0].status).toBe("idle");
	} finally { await pool.freeze(); }
});

test("a failed checkpoint retains queued execution evidence for the next review", async () => {
	const preset = defaultConfig().presets.default; preset.reviewers = preset.reviewers.slice(0, 1);
	const states = [newReviewer()]; const first = deferred<AssistantMessage>();
	let calls = 0;
	const pool = new ReviewPool(preset, states, process.cwd(), async (_index, context, signal) => {
		if (++calls === 1) return abortable(first.promise, signal);
		expect(JSON.stringify(context.messages)).toContain("Native edit and shell assertion both succeeded");
		return report(2);
	}, () => true);
	try {
		pool.enqueue(0, "Initial delegation");
		pool.enqueue(1, "Native edit and shell assertion both succeeded");
		const checkpoint = pool.checkpoint(1, "Reconfirm");
		first.resolve(reply("write", {}));
		expect((await checkpoint).warnings.join("\n")).toContain("forbidden");
		expect(states[0].pending).toEqual([]);
		expect(JSON.stringify(states[0].messages)).toContain("has not been reviewed");
		expect((await pool.checkpoint(2, "Next assessment")).warnings).toEqual([]);
	} finally { await pool.freeze(); }
});

for (const failure of ["tool", "reported"]) test(`empty findings cannot hide ${failure} review failure`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-incomplete-"));
	const preset = defaultConfig().presets.default; preset.reviewers = preset.reviewers.slice(0, 1);
	let calls = 0;
	const pool = new ReviewPool(preset, [newReviewer()], dir, async () => {
		if (++calls === 1 && failure === "tool") return reply("read", { path: "missing.txt" });
		return reply("mixture_review", { revision: 1, findings: [], ...(failure === "reported" ? { incompleteReason: "Visual check unavailable" } : {}) });
	}, () => true);
	try {
		const result = await pool.checkpoint(1, "Check");
		expect(result.warnings.join("\n")).toContain(failure === "tool" ? "Read-only tool failures: read" : "Visual check unavailable");
	} finally { await pool.freeze(); rmSync(dir, { recursive: true, force: true }); }
});

test("an incomplete structured report cannot clear a prior concern", async () => {
	const preset = defaultConfig().presets.default; preset.reviewers = preset.reviewers.slice(0, 1);
	let calls = 0;
	const pool = new ReviewPool(preset, [newReviewer()], process.cwd(), async () => ++calls === 1 ? report(1, [issue])
		: reply("mixture_review", { revision: 2, findings: [], incompleteReason: "Could not re-read the changed file" }), () => true);
	try {
		expect((await pool.checkpoint(1, "Initial check")).findings).toHaveLength(1);
		const result = await pool.checkpoint(2, "Reconfirm after edit");
		expect(result.warnings.join("\n")).toContain("Could not re-read");
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]).toMatchObject({ id: "missing-check", revision: 1 });
	} finally { await pool.freeze(); }
});

test("execution deltas preserve multiline edits and failure labels", () => {
	const message = reply("edit", { path: "fixture", oldText: "old\nline", newText: "new\nline" });
	const call = message.content[0]; if (call.type !== "toolCall") throw new Error("fixture");
	const delta = executionDelta(message, [{ role: "toolResult", toolName: "edit", toolCallId: call.id, content: [{ type: "text", text: "first\nsecond" }], isError: true, timestamp: 1 }], 4);
	expect(delta).toContain('"oldText": "old\\nline"');
	expect(delta).toContain("Result (FAILED):\nfirst\nsecond");
	expect(delta).toContain("revision 4");
});
