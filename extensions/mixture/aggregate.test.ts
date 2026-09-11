import { describe, expect, test } from "bun:test";
import { formatMixture, renderMixture } from "./aggregate.ts";
import type { WorkerResult } from "./runner.ts";

const worker = (overrides: Partial<WorkerResult> & { model: string }): WorkerResult => ({
	status: "ok",
	output: "output text",
	usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 1 },
	branch: "pi-mixture/run/slot-0",
	worktree: "/tmp/wt",
	...overrides,
});

describe("mixture aggregation", () => {
	test("renders every labeled output with status and usage", () => {
		const output = formatMixture("Do it", [worker({ model: "a" }), worker({ model: "b" })]);
		expect(output.succeeded).toBe(2);
		expect(output.failed).toBe(0);
		const text = renderMixture(output);
		expect(text).toContain("## a [ok]");
		expect(text).toContain("## b [ok]");
		expect(text).toContain("output text");
		expect(text).toContain("branch=pi-mixture/run/slot-0");
		expect(text).toContain("2 of 2 workers succeeded");
	});

	test("partial failure keeps successes and names errors", () => {
		const output = formatMixture("Do it", [
			worker({ model: "a", output: "good answer" }),
			worker({ model: "b", status: "timeout", output: "", error: "Worker exceeded 50ms" }),
		]);
		expect(output.succeeded).toBe(1);
		expect(output.failed).toBe(1);
		const text = renderMixture(output);
		expect(text).toContain("good answer");
		expect(text).toContain("## b [timeout]");
		expect(text).toContain("Worker exceeded 50ms");
	});

	test("total failure still returns a readable result", () => {
		const output = formatMixture("Do it", [worker({ model: "a", status: "failed", output: "", error: "boom" })]);
		const text = renderMixture(output);
		expect(text).toContain("0 of 1 workers succeeded");
		expect(text).toContain("boom");
	});
});
