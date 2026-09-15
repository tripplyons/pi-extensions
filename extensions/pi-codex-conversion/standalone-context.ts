import type { Message } from "@earendil-works/pi-ai";
import { convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { appendActiveMessage, commitContextTransition, parseLocalContext, reconcileLocalContext, scheduleContextTransition, serializeLocalContext, type LocalContextState } from "./local-context.ts";

export interface StandaloneContextSnapshot {
	version: 1;
	state: LocalContextState;
	cursor: { entryId?: string; pendingMessage: boolean };
}

function conversationEntry(entry: SessionEntry): boolean {
	return ["message", "custom_message", "branch_summary", "compaction"].includes(entry.type);
}

export function snapshotStandaloneContext(state: LocalContextState, branch: SessionEntry[], pendingMessage = false): StandaloneContextSnapshot {
	return { version: 1, state: serializeLocalContext(state), cursor: { entryId: branch.findLast(conversationEntry)?.id, pendingMessage } };
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
