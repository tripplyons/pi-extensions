import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, newId, nodeFile, readNode, stateRoot, updateNode, writeJson } from "./state.ts";
import { SCHEMA_VERSION, type NodeRecord } from "./types.ts";

test("validates opaque state paths and configuration limits", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-state-"));
	const previousHome = process.env.PI_SWARM_HOME;
	const previousConfig = process.env.PI_SWARM_CONFIG;
	process.env.PI_SWARM_HOME = root;
	process.env.PI_SWARM_CONFIG = join(root, "config.json");
	try {
		expect(stateRoot()).toBe(root);
		expect(() => nodeFile("../run_bad", "node_ok")).toThrow("Invalid swarm run id");
		writeFileSync(process.env.PI_SWARM_CONFIG, '{"maxDepth":0}\n');
		expect(loadConfig).toThrow("maxDepth");
		const runId = newId("run");
		const nodeId = newId("node");
		writeJson(nodeFile(runId, nodeId), { schemaVersion: SCHEMA_VERSION, runId, nodeId });
		expect(() => readNode(runId, nodeId)).toThrow("Invalid swarm node");
		const node: NodeRecord = {
			schemaVersion: SCHEMA_VERSION, runId, nodeId, parentId: null, childIds: [], role: "coordinator",
			task: "test", reviewTargetId: null, status: "running", version: 1, createdAt: 1, updatedAt: 1,
			deadlineAt: null, pausedAt: null, sessionId: null, cwd: root, branch: null, baseCommit: null,
			result: null, review: null, integrationCommit: null, failure: null, tmuxSession: null,
			tmuxWindow: null, pid: null, model: null, thinking: null, sandbox: null, cleanedAt: null,
		};
		writeJson(nodeFile(runId, nodeId), node);
		expect(readNode(runId, nodeId)).toEqual(node);
		expect(() => updateNode(runId, nodeId, (value) => { value.status = "completed"; }, 1)).toThrow("transition");
		expect(readNode(runId, nodeId)).toEqual(node);
		updateNode(runId, nodeId, (value) => { value.status = "stopped"; }, 1);
		expect(readNode(runId, nodeId).version).toBe(2);
		expect(() => updateNode(runId, nodeId, () => {}, 1)).toThrow("expected v1");
	} finally {
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		if (previousConfig === undefined) delete process.env.PI_SWARM_CONFIG; else process.env.PI_SWARM_CONFIG = previousConfig;
		rmSync(root, { recursive: true, force: true });
	}
});
