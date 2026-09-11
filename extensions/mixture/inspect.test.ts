import { expect, test } from "bun:test";
import { inspectRun, renderInspection, summarizeRun } from "./inspect.ts";
import { emptyUsage, type Run } from "./state.ts";

const run: Run = {
	schemaVersion: 1, id: "mix_inspect", ownerSession: "root", createdAt: 1, updatedAt: 2,
	supervisorPid: 0, options: { task: "test", models: ["model"], cwd: "/repo", thinking: "medium", timeoutMs: 100 },
	commands: [{ id: "cmd_stop", session: "root", action: "stop", createdAt: 1, status: "accepted" }],
	workers: [{ id: "slot-0", model: "model", cwd: "/retained", branch: "retained", changes: "?? result.txt", attempts: [
		{ attempt: 1, status: "failed", startedAt: 1, finishedAt: 2, output: "partial", error: "failure", usage: emptyUsage(), logFile: "/log", sessionFile: "/session" },
	] }],
};

test("inspection keeps partial output, usage, artifacts and command acknowledgements", () => {
	expect(inspectRun(run).workers).toEqual(run.workers);
	expect(inspectRun(run).commands).toEqual(run.commands);
	expect(summarizeRun(run).workers[0].status).toBe("failed");
	expect(() => inspectRun(run, "missing")).toThrow("Unknown worker");
});

test("inspection bounds multibyte output and points to full retained state", () => {
	const text = renderInspection({ output: "🌲".repeat(30000) }, "/state/run.json");
	expect(Buffer.byteLength(text)).toBeLessThan(50000);
	expect(text).not.toContain("�");
	expect(text).toContain("Full retained state: /state/run.json");
	expect(renderInspection({ output: "391" }, "/state")).toBe(JSON.stringify({ output: "391" }, null, 2));
});

test("inspection bounds line-heavy output", () => {
	const text = renderInspection(Array.from({ length: 3000 }, () => "x"), "/state");
	expect(text.split("\n").length).toBeLessThan(2000);
	expect(text).toContain("Truncated");
});
