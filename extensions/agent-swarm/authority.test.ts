import { expect, test } from "bun:test";
import { authenticateRequest, authorizeRequest } from "./authority.ts";
import { SCHEMA_VERSION, type NodeRecord, type Role, type SwarmRequest } from "./types.ts";

const node = (role: Role, nodeId = "node_parent", parentId: string | null = null) => ({
	runId: "run_test", nodeId, parentId, role, status: "running", version: 1,
}) as NodeRecord;

test("capabilities bind a request to its mailbox and version", () => {
	const actor = node("worker");
	const request: SwarmRequest = {
		schemaVersion: SCHEMA_VERSION, requestId: "req_test", runId: actor.runId,
		nodeId: actor.nodeId, token: "private-capability", kind: "send",
		expectedVersion: 1, createdAt: Date.now(), payload: {},
	};
	expect(() => authenticateRequest(request, actor, request.token)).not.toThrow();
	expect(() => authenticateRequest({ ...request, token: "forged" }, actor, request.token)).toThrow("capability");
	expect(() => authenticateRequest({ ...request, nodeId: "node_other" }, actor, request.token)).toThrow("mailbox");
	expect(() => authenticateRequest({ ...request, expectedVersion: 0 }, actor, request.token)).toThrow("Stale");
});

test("heartbeats and completions tolerate a concurrent version bump", () => {
	const actor = node("worker");
	const base = {
		schemaVersion: SCHEMA_VERSION, requestId: "req_test", runId: actor.runId,
		nodeId: actor.nodeId, token: "private-capability",
		expectedVersion: 0, createdAt: Date.now(), payload: {},
	} as const;
	expect(() => authenticateRequest({ ...base, kind: "heartbeat" }, actor, base.token)).not.toThrow();
	expect(() => authenticateRequest({ ...base, kind: "complete" }, actor, base.token)).not.toThrow();
});

test("managers and the root coordinator integrate direct children; leaves cannot delegate", () => {
	const child = node("worker", "node_child", "node_parent");
	for (const role of ["worker", "reviewer"] as const) {
		expect(() => authorizeRequest(node(role), "spawn")).toThrow("cannot spawn");
		expect(() => authorizeRequest(node(role), "review", child)).toThrow("cannot manage");
	}
	expect(() => authorizeRequest(node("coordinator"), "integrate", child)).not.toThrow();
	expect(() => authorizeRequest(node("manager"), "integrate", child)).not.toThrow();
	expect(() => authorizeRequest(node("coordinator"), "integrate", { ...child, parentId: "node_other" })).toThrow("direct child");
	expect(() => authorizeRequest(node("manager"), "review", { ...child, parentId: "node_other" })).toThrow("direct child");
	expect(() => authorizeRequest(node("worker"), "send", { ...child, runId: "run_other" })).toThrow("this run");
	expect(() => authorizeRequest(node("coordinator"), "stop", { ...child, parentId: "node_other" })).not.toThrow();
	expect(() => authorizeRequest(node("manager"), "stop", { ...child, parentId: "node_other" })).toThrow("direct child");
});
