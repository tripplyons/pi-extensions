import { join } from "node:path";
import { inboxDir, newId, readJson, responseFile, writeRequest } from "./state.ts";
import { SCHEMA_VERSION, type MessageRecord, type NodeRecord, type RequestKind, type RunStatus, type SwarmResponse } from "./types.ts";
import { packPayload } from "./artifacts.ts";

export interface WorkerSnapshot {
	schemaVersion: number;
	status: RunStatus;
	maxInlineBytes: number;
	node: NodeRecord;
	nodes: NodeRecord[];
	messages: MessageRecord[];
}

export class WorkerMailbox {
	private queue: Promise<unknown> = Promise.resolve();
	readonly runId = process.env.PI_SWARM_RUN!;
	readonly nodeId = process.env.PI_SWARM_NODE!;
	private readonly token = process.env.PI_SWARM_TOKEN!;

	constructor() {
		if (!this.runId || !this.nodeId || !this.token) throw new Error("Worker capability environment is incomplete");
		inboxDir(this.runId, this.nodeId);
	}

	snapshot() {
		const snapshot = readJson<WorkerSnapshot>(join(inboxDir(this.runId, this.nodeId), "snapshot.json"));
		if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.node.runId !== this.runId || snapshot.node.nodeId !== this.nodeId) throw new Error("Worker snapshot is unavailable or invalid");
		return snapshot;
	}

	response(requestId: string) { return readJson<SwarmResponse>(responseFile(this.runId, this.nodeId, requestId)); }

	request(kind: RequestKind, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const pending = this.queue.then(async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				signal?.throwIfAborted();
				const requestId = newId("req");
				const snapshot = this.snapshot();
				writeRequest({ schemaVersion: SCHEMA_VERSION, requestId, runId: this.runId, nodeId: this.nodeId, token: this.token, kind, payload: packPayload(this.runId, this.nodeId, requestId, payload, snapshot.maxInlineBytes), expectedVersion: snapshot.node.version, createdAt: Date.now() });
				const deadline = Date.now() + 30000;
				while (Date.now() < deadline) {
					signal?.throwIfAborted();
					const response = this.response(requestId);
					if (response) {
						if (response.ok) return response.result;
						if (response.error?.includes("Stale worker request")) break;
						throw new Error(response.error ?? "Controller rejected the request");
					}
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				if (!this.response(requestId)) return { pending: true, requestId, message: "The controller has not answered. Inspect this request with swarm_task; do not repeat the operation." };
			}
			throw new Error("Worker state kept changing; inspect swarm_task before retrying");
		});
		this.queue = pending.catch(() => {});
		return pending;
	}
}
