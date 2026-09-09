import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { authenticateRequest, authorizeRequest } from "./authority.ts";
import { auditDir, readJson, writeJson, writeResponse } from "./state.ts";
import { SCHEMA_VERSION, type NodeRecord, type RequestKind, type SwarmRequest, type SwarmResponse } from "./types.ts";

const kinds = new Set<RequestKind>(["ready", "heartbeat", "spawn", "send", "complete", "review", "integrate", "stop", "restart", "cleanup"]);

export function readBoundedFile(path: string, maxBytes: number): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("Request must be a bounded regular file");
		// Read through the checked descriptor, not a path the worker can replace.
		const bytes = Buffer.alloc(maxBytes + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (!count) break;
			offset += count;
		}
		if (offset > maxBytes) throw new Error("Request exceeds byte limit");
		return bytes.subarray(0, offset).toString("utf8");
	} finally { closeSync(fd); }
}

export function readRequest(path: string, maxBytes: number): SwarmRequest {
	const value = JSON.parse(readBoundedFile(path, maxBytes));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request must be an object");
	for (const [key, prefix] of [["requestId", "req"], ["runId", "run"], ["nodeId", "node"]]) {
		if (typeof value[key] !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value[key])) throw new Error(`Invalid request ${key}`);
	}
	if (value.schemaVersion !== SCHEMA_VERSION || !kinds.has(value.kind)) throw new Error("Unsupported request schema or operation");
	if (typeof value.token !== "string" || !value.token) throw new Error("Missing request capability");
	if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 0) throw new Error("Invalid request version");
	if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error("Invalid request timestamp");
	if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) throw new Error("Request payload must be an object");
	return value;
}

interface RequestJournal {
	request: Omit<SwarmRequest, "token">;
	response: SwarmResponse | null;
}

/** Apply under the run's single-owner lock; never retry an ambiguous side effect. */
export async function applyRequest(request: SwarmRequest, node: NodeRecord, token: string, apply: () => unknown | Promise<unknown>, target?: NodeRecord): Promise<SwarmResponse> {
	// Replays still authenticate their mailbox, but use the recorded version.
	const path = join(auditDir(node.runId), node.nodeId, `${request.requestId}.json`);
	authenticateRequest(request, { ...node, version: request.expectedVersion }, token);
	if (!/^req_[A-Za-z0-9]+$/.test(request.requestId)) throw new Error("Invalid request id");
	const { token: _token, ...redacted } = request;
	const previous = readJson<RequestJournal>(path);
	if (previous) {
		if (JSON.stringify(previous.request) !== JSON.stringify(redacted)) throw new Error("Request id reused with different contents");
		const response = previous.response ?? {
			schemaVersion: SCHEMA_VERSION, requestId: request.requestId, ok: false, createdAt: Date.now(),
			error: "Controller interrupted during this request; inspect state before issuing a new operation",
		};
		if (!previous.response) writeJson(path, { request: redacted, response });
		writeResponse(node.runId, node.nodeId, response);
		return response;
	}
	authenticateRequest(request, node, token);
	authorizeRequest(node, request.kind, target);
	writeJson(path, { request: redacted, response: null });
	let response: SwarmResponse;
	try {
		const result = await apply();
		response = { schemaVersion: SCHEMA_VERSION, requestId: request.requestId, ok: true, createdAt: Date.now(), result };
	} catch (error) {
		response = { schemaVersion: SCHEMA_VERSION, requestId: request.requestId, ok: false, createdAt: Date.now(), error: String(error) };
	}
	writeJson(path, { request: redacted, response });
	writeResponse(node.runId, node.nodeId, response);
	return response;
}
