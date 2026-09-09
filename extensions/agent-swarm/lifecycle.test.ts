import { expect, test } from "bun:test";
import { assertSpawnLimits, assertTransition } from "./lifecycle.ts";
import { defaultConfig, type NodeRecord } from "./types.ts";

const root = { runId: "run_test", nodeId: "node_root", parentId: null, role: "coordinator", status: "running" } as NodeRecord;
const manager = { ...root, nodeId: "node_manager", parentId: root.nodeId, role: "manager" } as NodeRecord;

test("review and restart follow explicit lifecycle edges", () => {
	expect(() => assertTransition("running", "awaiting-review")).not.toThrow();
	expect(() => assertTransition("awaiting-review", "rework")).not.toThrow();
	expect(() => assertTransition("stopped", "starting")).not.toThrow();
	expect(() => assertTransition("running", "completed")).toThrow("Invalid lifecycle");
	expect(() => assertTransition("completed", "running")).toThrow("Invalid lifecycle");
});

test("spawn limits count awaiting review and reject malformed ancestry", () => {
	expect(() => assertSpawnLimits(defaultConfig, manager, "worker", [root, manager])).not.toThrow();
	expect(() => assertSpawnLimits({ ...defaultConfig, maxDepth: 1 }, manager, "worker", [root, manager])).toThrow("depth");
	expect(() => assertSpawnLimits(defaultConfig, manager, "worker", [manager])).toThrow("ancestor");
	const child = { ...manager, nodeId: "node_child", parentId: manager.nodeId, status: "awaiting-review" } as NodeRecord;
	expect(() => assertSpawnLimits({ ...defaultConfig, maxActiveChildren: 1 }, manager, "worker", [root, manager, child])).toThrow("children");
	expect(() => assertSpawnLimits({ ...defaultConfig, maxActiveNodes: 2 }, root, "worker", [root, manager, child])).toThrow("nodes");
	expect(() => assertSpawnLimits(defaultConfig, manager, "worker", [manager, { ...root, parentId: manager.nodeId }])).toThrow("Cycle");
});
