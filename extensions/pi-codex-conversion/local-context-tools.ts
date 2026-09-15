import { StringEnum } from "@earendil-works/pi-ai";
import { estimateTokens, type AgentToolResult, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HISTORY_ACTIONS, HISTORY_DESCRIPTION, NOTES_ACTIONS, NOTES_DESCRIPTION, type HistoryAction, type NotesAction } from "@howaboua/pi-codex-conversion/src/context-management/tool-contract.ts";
import { commitContextTransition, contextRemaining, localHistory, localNotes, messageGroups, scheduleContextTransition, type LocalContextState } from "./local-context.ts";

export const LOCAL_CONTEXT_TOOLS = ["history", "notes", "new_context", "get_context_remaining"] as const;
export interface LocalContextTarget {
	state: LocalContextState;
	contextWindow: number;
	reserveTokens: number;
	usedTokens?: number;
	changed(): void;
}
export interface LocalContextQuery { sessionId: string; target?: LocalContextTarget }
export const LOCAL_CONTEXT_QUERY_EVENT = "pi-codex-conversion:local-context-query";

export const HistoryParameters = Type.Object({
	action: StringEnum(HISTORY_ACTIONS), agent_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	item_id: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1 })), limit_chars: Type.Optional(Type.Integer({ minimum: 1 })),
	max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1 })), offset_chars: Type.Optional(Type.Integer({ minimum: 0 })), query: Type.Optional(Type.String()),
	recent_first: Type.Optional(Type.Boolean()), role: Type.Optional(Type.Union([StringEnum(["user", "assistant", "tool", "system", "developer"] as const), Type.Null()])),
	tool_name: Type.Optional(Type.Union([Type.String(), Type.Null()])), tool_namespace: Type.Optional(Type.Union([Type.String(), Type.Null()])), window_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: false });
export const NotesParameters = Type.Object({
	action: StringEnum(NOTES_ACTIONS), file_order: Type.Optional(StringEnum(["ascending", "descending"] as const)), file_order_by: Type.Optional(StringEnum(["name", "created_at", "updated_at"] as const)),
	max_files: Type.Optional(Type.Integer({ minimum: 1 })), max_matches_per_file: Type.Optional(Type.Integer({ minimum: 1 })), max_results: Type.Optional(Type.Integer({ minimum: 1 })),
	path: Type.Optional(Type.String()), path_prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])), prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])), query: Type.Optional(Type.String()),
	recent_file_first: Type.Optional(Type.Boolean()), start_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])), stop_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])), text: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const EmptyParameters = Type.Object({}, { additionalProperties: false });

function result(data: Record<string, unknown>): AgentToolResult<{ localContext: Record<string, unknown> }> {
	return { content: [{ type: "text", text: JSON.stringify(data) }], details: { localContext: data } };
}
function requireTarget(pi: ExtensionAPI, sessionId: string, standalone: () => LocalContextTarget | undefined) {
	const query: LocalContextQuery = { sessionId };
	pi.events.emit(LOCAL_CONTEXT_QUERY_EVENT, query);
	const target = query.target ?? standalone();
	if (!target) throw new Error("Local context is available only for standalone Codex or an active Mixture actor");
	return target;
}

export function createLocalContextTools(pi: ExtensionAPI, standalone: () => LocalContextTarget | undefined): ToolDefinition<any, any>[] {
	return [
		{ name: "history", label: "history", description: HISTORY_DESCRIPTION, parameters: HistoryParameters, async execute(_id, params, _signal, _update, ctx) {
			const target = requireTarget(pi, ctx.sessionManager.getSessionId(), standalone);
			return result(localHistory(target.state, params.action as HistoryAction, params));
		} },
		{ name: "notes", label: "notes", description: NOTES_DESCRIPTION, parameters: NotesParameters, executionMode: "sequential", async execute(_id, params, _signal, _update, ctx) {
			const target = requireTarget(pi, ctx.sessionManager.getSessionId(), standalone);
			const output = localNotes(target.state, params.action as NotesAction, params); target.changed(); return result(output);
		} },
		{ name: "new_context", label: "new_context", description: "Start a new local context window after this complete tool batch.", parameters: EmptyParameters, executionMode: "sequential", async execute(_id, _params, _signal, _update, ctx) {
			const target = requireTarget(pi, ctx.sessionManager.getSessionId(), standalone);
			const candidate = structuredClone(target.state);
			const groups = messageGroups(candidate.activeMessages);
			const boundaryGroup = groups.findLast(group => group[0].role === "assistant" && group[0].content.some(block => block.type === "toolCall" && block.name === "new_context"));
			scheduleContextTransition(candidate);
			commitContextTransition(candidate, { currentTask: candidate.activeMessages.findLast(message => message.role === "user"), boundaryGroup });
			const inputLimit = Math.max(0, target.contextWindow - Math.max(0, target.reserveTokens));
			if (candidate.activeMessages.reduce((sum, message) => sum + estimateTokens(message), 0) > inputLimit) throw new Error("Private notes and window boundary exceed the local context input budget; the current window was preserved");
			const alreadyPending = !!target.state.pending; const transition = scheduleContextTransition(target.state); target.changed();
			return result({ started: !alreadyPending, window_id: transition.toWindowId });
		} },
		{ name: "get_context_remaining", label: "get_context_remaining", description: "Get the remaining tokens in this actor's local context window.", parameters: EmptyParameters, async execute(_id, _params, _signal, _update, ctx) {
			const target = requireTarget(pi, ctx.sessionManager.getSessionId(), standalone);
			return result(contextRemaining(target.state, target.contextWindow, target.reserveTokens, target.usedTokens));
		} },
	];
}
