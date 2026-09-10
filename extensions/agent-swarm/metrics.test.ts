import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSwarmStatus, sessionCost, workerCost } from "./metrics.ts";
import { makeNode } from "./runtime.ts";
import { workerHome } from "./state.ts";

const usage = (total: unknown) => ({ cost: { total } });

test("session cost recognizes Pi cost-bearing entry kinds and ignores unrelated values", () => {
	expect(sessionCost([
		{ type: "message", message: { role: "assistant", usage: usage(1.25) } },
		{ type: "message", message: { role: "toolResult", usage: usage(0.25) } },
		{ type: "compaction", usage: usage(2) },
		{ type: "branch_summary", usage: usage(4) },
		{ type: "message", message: { role: "user", usage: usage(100) } },
		{ type: "message", message: { role: "assistant", usage: usage(Number.NaN) } },
		{ type: "other", usage: usage(100) },
	])).toBe(7.5);
});

test("worker cost sums every session file while tolerating an unterminated final record", () => {
	const state = mkdtempSync(join(tmpdir(), "pi-swarm-metrics-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = state;
	const node = makeNode("run_metrics", "node_worker", "worker", "task", "/tmp", "node_root");
	try {
		const sessions = join(workerHome(node.runId, node.nodeId), ".pi", "agent", "sessions");
		mkdirSync(join(sessions, "nested"), { recursive: true });
		writeFileSync(join(sessions, "one.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", usage: usage(1) } })}\n${JSON.stringify({ type: "compaction", usage: usage(2) })}\n`);
		writeFileSync(join(sessions, "nested", "two.jsonl"), `${JSON.stringify({ type: "branch_summary", usage: usage(4) })}\n{\"partial\":`);
		writeFileSync(join(sessions, "ignore.txt"), JSON.stringify({ type: "compaction", usage: usage(100) }));
		expect(workerCost(node)).toBe(7);
		rmSync(workerHome(node.runId, node.nodeId), { recursive: true });
		node.estimatedCost = 7;
		expect(workerCost(node)).toBe(7);
	} finally {
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(state, { recursive: true, force: true });
	}
});

test("worker cost rejects a malformed completed JSONL record", () => {
	const state = mkdtempSync(join(tmpdir(), "pi-swarm-corrupt-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = state;
	const node = makeNode("run_corrupt", "node_worker", "worker", "task", "/tmp", "node_root");
	try {
		const sessions = join(workerHome(node.runId, node.nodeId), ".pi", "agent", "sessions");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "bad.jsonl"), "not-json\n");
		expect(() => workerCost(node)).toThrow("Invalid worker session entry");
	} finally {
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(state, { recursive: true, force: true });
	}
});

test("status formatting stays compact and aggregates lifecycle and role counts", () => {
	const root = makeNode("run_format", "node_root", "coordinator", "root", "/tmp", null);
	const workers = Array.from({ length: 500 }, (_, index) => {
		const node = makeNode(root.runId, `node_${index}`, index % 2 ? "worker" : "reviewer", "x", "/tmp", root.nodeId);
		node.status = index % 2 ? "running" : "completed";
		return node;
	});
	const run: any = { status: "active", createdAt: 0, updatedAt: 0 };
	const output = formatSwarmStatus(run, [root, ...workers], 12, 123.4567, 3_661_000);
	expect(output.split("\n")).toHaveLength(5);
	expect(output).toContain("Swarm: active · 1h 1m 1s");
	expect(output).toContain("Nodes: 500 · running 250 · completed 250");
	expect(output).toContain("Roles: worker 250 · reviewer 250");
	expect(output).toContain("Estimated cost: $123.457");
	expect(output.length).toBeLessThan(250);
});

test("status formatting freezes stopped run elapsed time at updatedAt", () => {
	const root = makeNode("run_stopped", "node_root", "coordinator", "root", "/tmp", null);
	const run: any = { status: "stopped", createdAt: 1_000, updatedAt: 62_000 };
	const output = formatSwarmStatus(run, [root], 0, 0, 3_662_000);
	expect(output).toContain("Swarm: stopped · 1m 1s");
});
