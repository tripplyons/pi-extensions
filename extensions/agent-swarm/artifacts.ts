import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, inboxDir, outboxDir, runDir } from "./state.ts";
import { readBoundedFile } from "./requests.ts";

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const fields = ["task", "body", "text", "verification", "feedback"];
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

export function packPayload(runId: string, nodeId: string, requestId: string, payload: Record<string, unknown>, maxInlineBytes: number) {
	const packed = { ...payload };
	for (const field of fields) {
		const body = payload[field];
		if (typeof body !== "string" || Buffer.byteLength(body) <= Math.floor(maxInlineBytes / 8)) continue;
		if (Buffer.byteLength(body) > MAX_ARTIFACT_BYTES) throw new Error(`Swarm ${field} exceeds the 10 MiB artifact limit`);
		const name = `${requestId}-${field}.txt`;
		writeFileSync(join(outboxDir(runId, nodeId), name), body, { mode: 0o600, flag: "wx" });
		packed[field] = { artifact: name, sha256: digest(body) };
	}
	return packed;
}

export function unpackPayload(runId: string, nodeId: string, requestId: string, payload: Record<string, unknown>) {
	const unpacked = { ...payload };
	for (const field of fields) {
		const reference = payload[field];
		if (reference === null || typeof reference !== "object") continue;
		const { artifact, sha256 } = reference as { artifact?: unknown; sha256?: unknown };
		if (artifact !== `${requestId}-${field}.txt` || typeof sha256 !== "string") throw new Error("Invalid request artifact reference");
		const body = readBoundedFile(join(outboxDir(runId, nodeId), artifact), MAX_ARTIFACT_BYTES);
		if (digest(body) !== sha256) throw new Error("Request artifact changed after submission");
		unpacked[field] = body;
	}
	return unpacked;
}

export function textPreview(runId: string, recipient: string | null, body: string, maxBytes: number) {
	const directory = recipient ? join(inboxDir(runId, recipient), "artifacts") : join(runDir(runId), "control", "artifacts");
	return previewAt(directory, body, maxBytes);
}

export function previewAt(directory: string, body: string, maxBytes: number) {
	if (Buffer.byteLength(body) <= maxBytes) return body;
	ensureDir(directory);
	const path = join(directory, `${digest(body)}.txt`);
	if (!existsSync(path)) writeFileSync(path, body, { flag: "wx", mode: 0o600 });
	return `${Buffer.from(body).subarray(0, Math.min(2048, Math.floor(maxBytes / 2))).toString("utf8")}\nFull text: ${path}`;
}
