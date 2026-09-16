import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { applyDelta, cloneJson, createDelta, type DeltaOperation } from "../mixture/delta.ts";
import { appendActiveMessage, commitContextTransition, parseLocalContext, reconcileLocalContext, scheduleContextTransition, serializeLocalContext, type LocalContextState } from "./local-context.ts";

export interface StandaloneContextSnapshot {
	version: 1;
	state: LocalContextState;
	cursor: { entryId?: string; pendingMessage: boolean };
}

export interface StandaloneSnapshotEntry {
	version: 2;
	kind: "snapshot";
	hash: string;
	snapshot: StandaloneContextSnapshot;
}

export interface StandaloneDeltaEntry {
	version: 2;
	kind: "delta";
	baseHash: string;
	hash: string;
	changes: DeltaOperation[];
}

export type StoredStandaloneContext = StandaloneSnapshotEntry | StandaloneDeltaEntry;

export interface MaterializedStandaloneContext {
	state: LocalContextState;
	persisted?: StandaloneContextSnapshot;
	index: number;
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!object(value)) return value;
	return Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])]));
}
const hashJson = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshotHash = (snapshot: StandaloneContextSnapshot) => hashJson(canonical(snapshot));
const legacySnapshotHash = (snapshot: StandaloneContextSnapshot) => hashJson(snapshot);
const matchesSnapshotHash = (snapshot: StandaloneContextSnapshot, hash: string) => snapshotHash(snapshot) === hash || legacySnapshotHash(snapshot) === hash;

function conversationEntry(entry: SessionEntry): boolean {
	return ["message", "custom_message", "branch_summary", "compaction"].includes(entry.type);
}

export function snapshotStandaloneContext(state: LocalContextState, branch: SessionEntry[], pendingMessage = false): StandaloneContextSnapshot {
	return { version: 1, state: serializeLocalContext(state), cursor: { entryId: branch.findLast(conversationEntry)?.id, pendingMessage } };
}

export function encodeStandaloneContext(snapshot: StandaloneContextSnapshot, previous?: StandaloneContextSnapshot): StoredStandaloneContext | undefined {
	const hash = snapshotHash(snapshot);
	if (!previous) return { version: 2, kind: "snapshot", hash, snapshot: cloneJson(snapshot) };
	const baseHash = snapshotHash(previous);
	if (baseHash === hash) return undefined;
	return { version: 2, kind: "delta", baseHash, hash, changes: createDelta(previous, snapshot) };
}

function storedSnapshot(value: unknown): StandaloneContextSnapshot {
	if (!object(value) || value.version !== 2 || value.kind !== "snapshot" || typeof value.hash !== "string" || !object(value.snapshot)) throw new Error("Invalid standalone local context snapshot");
	const snapshot = cloneJson(value.snapshot) as StandaloneContextSnapshot;
	if (!matchesSnapshotHash(snapshot, value.hash)) throw new Error("Invalid standalone local context snapshot hash");
	return snapshot;
}

function applyStoredDelta(snapshot: StandaloneContextSnapshot, value: unknown): StandaloneContextSnapshot {
	if (!object(value) || value.version !== 2 || value.kind !== "delta" || typeof value.baseHash !== "string" || typeof value.hash !== "string") throw new Error("Invalid standalone local context delta");
	if (!matchesSnapshotHash(snapshot, value.baseHash)) throw new Error("Standalone local context delta base does not match");
	const next = applyDelta(snapshot, value.changes) as StandaloneContextSnapshot;
	if (!matchesSnapshotHash(next, value.hash)) throw new Error("Invalid standalone local context delta hash");
	return next;
}

function entryMessages(entry: SessionEntry): Message[] {
	if (entry.type === "message") return convertToLlm([entry.message]);
	if (entry.type === "custom_message") return convertToLlm([{ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: Date.parse(entry.timestamp) }]);
	if (entry.type === "branch_summary") return convertToLlm([{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: Date.parse(entry.timestamp) }]);
	return [];
}

function messageKey(message: Message): string {
	return JSON.stringify([message.role, message.content, message.role === "toolResult" ? message.toolCallId : undefined]);
}

export function restoreStandaloneContext(data: unknown, branch: SessionEntry[], snapshotIndex: number, nativeMessages: Message[]): LocalContextState {
	let sourceIndex = snapshotIndex;
	let pendingMessage = false;
	let state: LocalContextState;
	if (data && typeof data === "object" && Object.hasOwn(data, "state")) {
		const snapshot = data as StandaloneContextSnapshot;
		if (snapshot.version !== 1 || !snapshot.cursor || typeof snapshot.cursor.pendingMessage !== "boolean" || snapshot.cursor.entryId !== undefined && (typeof snapshot.cursor.entryId !== "string" || !snapshot.cursor.entryId)) throw new Error("Invalid standalone local context cursor");
		state = parseLocalContext(snapshot.state);
		sourceIndex = snapshot.cursor.entryId === undefined ? -1 : branch.findIndex(entry => entry.id === snapshot.cursor.entryId);
		if (snapshot.cursor.entryId !== undefined && sourceIndex < 0) throw new Error("Standalone local context cursor is not on the selected branch");
		if (sourceIndex >= snapshotIndex) throw new Error("Standalone local context cursor does not precede its snapshot");
		pendingMessage = snapshot.cursor.pendingMessage;
		if (pendingMessage && !state.activeMessages.length) throw new Error("Standalone local context pending message is missing");
	} else state = parseLocalContext(data);
	const capturedMessage = pendingMessage ? state.activeMessages.at(-1) : undefined;
	for (const entry of branch.slice(sourceIndex + 1)) {
		if (entry.type === "compaction") {
			reconcileLocalContext(state);
			scheduleContextTransition(state);
			commitContextTransition(state, { summary: entry.summary, boundaryGroup: nativeMessages });
			return state;
		}
		for (const message of entryMessages(entry)) {
			if (pendingMessage && capturedMessage && messageKey(capturedMessage) === messageKey(message)) {
				pendingMessage = false;
				continue;
			}
			pendingMessage = false;
			appendActiveMessage(state, message);
		}
	}
	reconcileLocalContext(state, nativeMessages.findLast(message => message.role === "user"));
	return state;
}

export function materializeStandaloneContext(branch: SessionEntry[], nativeMessages: Message[], customType: string): MaterializedStandaloneContext | undefined {
	let baseIndex = -1;
	let hasOrphanDelta = false;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== customType || object(entry.data) && entry.data.version === 0) continue;
		if (object(entry.data) && entry.data.version === 2 && entry.data.kind === "delta") {
			hasOrphanDelta = true;
			continue;
		}
		baseIndex = index;
		break;
	}
	if (baseIndex < 0) {
		if (hasOrphanDelta) throw new Error("Standalone local context delta has no base snapshot");
		return undefined;
	}
	const base = branch[baseIndex];
	if (base.type !== "custom") throw new Error("Standalone local context base is not custom data");
	if (!object(base.data) || base.data.version !== 2) return { state: restoreStandaloneContext(base.data, branch, baseIndex, nativeMessages), index: baseIndex };
	let persisted = storedSnapshot(base.data);
	let checkpointIndex = baseIndex;
	for (let index = baseIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== customType || !object(entry.data) || entry.data.version !== 2) continue;
		if (entry.data.kind === "snapshot") persisted = storedSnapshot(entry.data);
		else persisted = applyStoredDelta(persisted, entry.data);
		checkpointIndex = index;
	}
	return {
		state: restoreStandaloneContext(persisted, branch, checkpointIndex, nativeMessages),
		persisted,
		index: checkpointIndex,
	};
}
