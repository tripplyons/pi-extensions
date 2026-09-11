import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRequest, readRequest } from "./requests.ts";
import { auditDir, writeJson } from "./state.ts";
import { SCHEMA_VERSION, type NodeRecord, type SwarmRequest } from "./types.ts";

const request: SwarmRequest = {
	schemaVersion: SCHEMA_VERSION, requestId: "req_test", runId: "run_test", nodeId: "node_test",
	token: "capability", kind: "complete", expectedVersion: 1, createdAt: 1, payload: {},
};
const node = { runId: request.runId, nodeId: request.nodeId, version: 1, role: "worker", status: "running" } as NodeRecord;

test("request reader rejects links, oversized files, and malformed operations", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-requests-"));
	const path = join(root, "request.json");
	try {
		writeFileSync(path, JSON.stringify(request));
		expect(readRequest(path, 1024)).toEqual(request);
		expect(() => readRequest(path, 10)).toThrow("bounded");
		symlinkSync(path, join(root, "link"));
		expect(() => readRequest(join(root, "link"), 1024)).toThrow();
		writeFileSync(path, JSON.stringify({ ...request, kind: "arbitrary-exec" }));
		expect(() => readRequest(path, 1024)).toThrow("operation");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("completions and heartbeats survive a concurrent version bump", async () => {
	const previousHome = process.env.PI_SWARM_HOME;
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-stale-"));
	process.env.PI_SWARM_HOME = root;
	let applied = 0;
	try {
		const ahead = { ...node, version: 2 };
		const heartbeat = await applyRequest({ ...request, requestId: "req_heartbeat", kind: "heartbeat", expectedVersion: 1 }, ahead, request.token, async () => ++applied);
		expect(heartbeat.ok).toBe(true);
		const completion = await applyRequest({ ...request, requestId: "req_completion", kind: "complete", expectedVersion: 1 }, ahead, request.token, async () => ++applied);
		expect(completion.ok).toBe(true);
		expect(applied).toBe(2);
		await expect(applyRequest({ ...request, requestId: "req_send", kind: "send", expectedVersion: 1 }, ahead, request.token, () => ++applied)).rejects.toThrow("Stale");
		expect(applied).toBe(2);
	} finally {
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
});

test("durable replay never repeats a side effect or trusts a replacement capability", async () => {
	const previousHome = process.env.PI_SWARM_HOME;
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-journal-"));
	process.env.PI_SWARM_HOME = root;
	let applied = 0;
	try {
		const first = await applyRequest(request, node, request.token, async () => ++applied);
		expect(first.ok).toBe(true);
		expect(await applyRequest(request, { ...node, version: 2 }, request.token, () => ++applied)).toEqual(first);
		expect(applied).toBe(1);
		await expect(applyRequest({ ...request, requestId: "req_spawn", kind: "spawn" }, node, request.token, () => ++applied)).rejects.toThrow("cannot spawn");
		expect(applied).toBe(1);
		await expect(applyRequest({ ...request, token: "forged" }, node, request.token, () => ++applied)).rejects.toThrow("capability");
		await expect(applyRequest({ ...request, payload: { changed: true } }, node, request.token, () => ++applied)).rejects.toThrow("reused");
		const interrupted = { ...request, requestId: "req_interrupted" };
		const { token: _token, ...redacted } = interrupted;
		writeJson(join(auditDir(node.runId), node.nodeId, `${interrupted.requestId}.json`), { request: redacted, response: null });
		expect((await applyRequest(interrupted, node, request.token, () => ++applied)).error).toContain("interrupted");
		expect(applied).toBe(1);
	} finally {
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
});
