import { timingSafeEqual } from "node:crypto";
import { SCHEMA_VERSION, directRelatives, roleCanSpawn, type NodeRecord, type SwarmRequest } from "./types.ts";

export const visibleNodes = (actor: NodeRecord, nodes: NodeRecord[]) => nodes.filter((node) =>
	node.runId === actor.runId && (actor.role === "coordinator" || actor.nodeId === node.nodeId || directRelatives(actor, node)),
);

export function authenticateRequest(request: SwarmRequest, node: NodeRecord, token: string) {
	if (request.schemaVersion !== SCHEMA_VERSION || request.runId !== node.runId || request.nodeId !== node.nodeId) {
		throw new Error("Request identity does not match its mailbox");
	}
	if (typeof request.token !== "string") throw new Error("Missing worker capability");
	const supplied = Buffer.from(request.token);
	const expected = Buffer.from(token);
	if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Invalid worker capability");
	// Heartbeats advance the version themselves, and completions are validated
	// against current status/review in perform(). Requiring an exact version here
	// turns a concurrent heartbeat or message into a failed delivery.
	if (request.kind === "heartbeat" || request.kind === "complete") return;
	if (request.expectedVersion !== node.version) throw new Error("Stale worker request");
}

export function authorizeRequest(actor: NodeRecord, kind: SwarmRequest["kind"], target?: NodeRecord) {
	if (kind === "ready") {
		if (actor.status !== "starting") throw new Error("Readiness requires a starting node");
		return;
	}
	if (kind === "heartbeat") {
		if (!["starting", "running", "rework", "awaiting-review"].includes(actor.status)) throw new Error("Terminal nodes cannot heartbeat");
		return;
	}
	if (actor.status !== "running" && actor.status !== "rework") throw new Error(`Cannot act while ${actor.status}`);
	if (kind === "complete") {
		if (actor.role === "coordinator") throw new Error("Coordinator cannot submit a worker result");
		return;
	}
	if (kind === "spawn") {
		if (!roleCanSpawn(actor.role)) throw new Error(`${actor.role} cannot spawn children`);
		return;
	}
	if (!target || target.runId !== actor.runId) throw new Error("Target must belong to this run");
	if (kind === "stop" && actor.role === "coordinator" && target.nodeId !== actor.nodeId) return;
	const child = target.parentId === actor.nodeId;
	if (kind === "send") {
		if (!child && actor.parentId !== target.nodeId) throw new Error("Messages require a direct parent or child");
		return;
	}
	if (!child) throw new Error("Operation requires a direct child");
	if (!roleCanSpawn(actor.role)) throw new Error(`${actor.role} cannot manage children`);
	if (kind === "integrate" && actor.role !== "manager" && actor.role !== "coordinator") throw new Error("Only managers and the coordinator integrate children");
}
