import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNode } from "./runtime.ts";
import { inboxDir, queuedRequests, readJson, writeJson, writeResponse } from "./state.ts";
import { SCHEMA_VERSION, type SwarmRequest } from "./types.ts";
import { WorkerMailbox } from "./worker.ts";

test("a completion response received after suspension is consumed once, never resubmitted", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-mailbox-"));
	const previous = { ...process.env };
	Object.assign(process.env, { PI_SWARM_HOME: directory, PI_SWARM_RUN: "run_test", PI_SWARM_NODE: "node_test", PI_SWARM_TOKEN: "test" });
	const node = makeNode("run_test", "node_test", "worker", "work", directory, "node_root");
	node.status = "running";
	writeJson(join(inboxDir(node.runId, node.nodeId), "snapshot.json"), { schemaVersion: SCHEMA_VERSION, node, maxInlineBytes: 65536 });
	const mailbox = new WorkerMailbox();
	const now = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(now);
	const response = spyOn(mailbox, "response").mockImplementation((requestId) => ({ schemaVersion: SCHEMA_VERSION, requestId, ok: true, result: { commit: "saved" }, createdAt: now }));
	response.mockImplementationOnce((requestId) => {
		writeResponse(node.runId, node.nodeId, { schemaVersion: SCHEMA_VERSION, requestId, ok: true, result: { commit: "saved" }, createdAt: now });
		queueMicrotask(() => clock.mockReturnValue(now + 60_000));
		return null;
	});
	try {
		expect(await mailbox.request("complete", { text: "Done" })).toEqual({ commit: "saved" });
		expect(queuedRequests(node.runId, node.nodeId)).toHaveLength(1);
		response.mockRestore();
		const reject = spyOn(mailbox, "response").mockImplementation((requestId) => ({ schemaVersion: SCHEMA_VERSION, requestId, ok: false, error: "Stale worker request", createdAt: now }));
		try {
			await expect(mailbox.request("complete", { text: "Stale submission" })).rejects.toThrow("Stale worker request");
			expect(queuedRequests(node.runId, node.nodeId).map((path) => readJson<SwarmRequest>(path)!.payload.text).sort()).toEqual(["Done", "Stale submission"]);
		} finally { reject.mockRestore(); }
	} finally {
		response.mockRestore(); clock.mockRestore();
		for (const key of ["PI_SWARM_HOME", "PI_SWARM_RUN", "PI_SWARM_NODE", "PI_SWARM_TOKEN"]) {
			if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
		}
		rmSync(directory, { recursive: true, force: true });
	}
});
