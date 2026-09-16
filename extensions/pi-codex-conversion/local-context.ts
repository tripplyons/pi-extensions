import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { HistoryAction, NotesAction } from "@howaboua/pi-codex-conversion/src/context-management/tool-contract.ts";

export const LOCAL_CONTEXT_VERSION = 1;
export const MAX_NOTE_FILE_BYTES = 1_000_000;
export const MAX_NOTE_SNAPSHOT_BYTES = 10_000_000;
const LIST_ITEM_LIMIT = 25;
const LIST_ITEM_PREVIEW_CHARS = 1_000;
const READ_ITEM_LIMIT_CHARS = 8_000;
const LIST_OUTPUT_LIMIT_CHARS = 8_000;

export interface LocalContextIdentity {
	branchId: string;
	preset: string;
	role: string;
}

export interface LocalContextItem {
	id: string;
	role: string;
	content: string;
	toolName?: string;
	toolNamespace?: string;
}

export interface LocalContextWindow {
	id: string;
	items: LocalContextItem[];
	messages: Message[];
	summary?: string;
}

export interface LocalContextNote {
	path: string;
	text: string;
	createdAt: number;
	updatedAt: number;
}

export interface LocalContextTransition {
	fromWindowId: string;
	toWindowId: string;
	requestedAt: number;
}

export interface LocalContextState {
	version: 1;
	identity: LocalContextIdentity;
	activeWindowId: string;
	activeMessages: Message[];
	activeItems: LocalContextItem[];
	archives: LocalContextWindow[];
	notes: LocalContextNote[];
	pending?: LocalContextTransition;
}

export interface RemainingContext {
	remainingTokens?: number;
	windowId: string;
	contextWindow: number;
	budgetStatus?: "exhausted";
	guidance?: string;
}

const clone = <T>(value: T): T => structuredClone(value);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

function renderMessage(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => {
		if (block.type === "text") return block.text;
		if (block.type === "thinking") return block.thinking;
		if (block.type === "image") return `[image ${block.mimeType}]`;
		return JSON.stringify({ tool: block.name, arguments: block.arguments });
	}).join("\n");
}

function itemFromMessage(message: Message, id = randomUUID()): LocalContextItem {
	const record = message as unknown as Record<string, unknown>;
	const call = message.role === "assistant" && Array.isArray(message.content)
		? message.content.find((block) => block.type === "toolCall")
		: undefined;
	return {
		id,
		role: message.role === "toolResult" ? "tool" : message.role,
		content: renderMessage(message),
		...(typeof record.toolName === "string" ? { toolName: record.toolName } : call ? { toolName: call.name } : {}),
		...(call && typeof call.namespace === "string" ? { toolNamespace: call.namespace } : {}),
	};
}

function noteSnapshotBytes(notes: readonly LocalContextNote[]): number {
	return Buffer.byteLength(JSON.stringify({
		protocol: 1,
		timestamp: 0,
		files: notes.map((note) => ({
			path: note.path,
			text: note.text,
			createdAt: note.createdAt,
			updatedAt: note.updatedAt,
		})),
	}), "utf8");
}

function validMessage(value: unknown): value is Message {
	if (!isRecord(value) || !["user", "assistant", "toolResult"].includes(String(value.role)) || typeof value.timestamp !== "number" || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0) return false;
	if (value.role === "user" && typeof value.content === "string") return true;
	if (!Array.isArray(value.content) || !value.content.every(block => isRecord(block) && (
		block.type === "text" && typeof block.text === "string"
		|| block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
		|| value.role === "assistant" && block.type === "thinking" && typeof block.thinking === "string"
		|| value.role === "assistant" && block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string" && isRecord(block.arguments) && (block.namespace === undefined || typeof block.namespace === "string")
	))) return false;
	if (value.role === "assistant") {
		const usage = value.usage;
		const cost = isRecord(usage) ? usage.cost : undefined;
		return typeof value.provider === "string" && typeof value.model === "string" && typeof value.api === "string" && ["pending", "stop", "toolUse", "length", "error", "aborted", "deferred"].includes(String(value.stopReason))
			&& isRecord(usage) && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0)
			&& isRecord(cost) && ["input", "output", "cacheRead", "cacheWrite", "total"].every(key => typeof cost[key] === "number" && Number.isFinite(cost[key]) && Number(cost[key]) >= 0);
	}
	return value.role === "user" || typeof value.toolCallId === "string" && typeof value.toolName === "string" && typeof value.isError === "boolean";
}

function validateItem(value: unknown): asserts value is LocalContextItem {
	if (!isRecord(value) || !isId(value.id) || typeof value.role !== "string" || typeof value.content !== "string" || value.toolName !== undefined && typeof value.toolName !== "string" || value.toolNamespace !== undefined && typeof value.toolNamespace !== "string")
		throw new Error("Invalid local context v1 history item");
}

function validateProjection(messages: Message[], items: LocalContextItem[]): void {
	for (const [index, message] of messages.entries()) {
		const item = items[index];
		const expected = itemFromMessage(message, item.id);
		if (["role", "content", "toolName", "toolNamespace"].some(key => item[key as keyof LocalContextItem] !== expected[key as keyof LocalContextItem])) throw new Error("Invalid local context v1 item projection");
	}
}

function validateNotes(notes: unknown, role: string): asserts notes is LocalContextNote[] {
	if (!Array.isArray(notes)) throw new Error("Invalid local context v1 notes");
	const paths = new Set<string>();
	for (const note of notes) {
		if (!isRecord(note) || typeof note.path !== "string" || typeof note.text !== "string" || typeof note.createdAt !== "number" || !Number.isFinite(note.createdAt) || typeof note.updatedAt !== "number" || !Number.isFinite(note.updatedAt) || Buffer.byteLength(note.text, "utf8") > MAX_NOTE_FILE_BYTES)
			throw new Error("Invalid local context v1 note");
		if (notePath(note.path, role) !== note.path || paths.has(note.path)) throw new Error("Invalid or duplicate local context v1 note path");
		paths.add(note.path);
	}
	if (noteSnapshotBytes(notes) > MAX_NOTE_SNAPSHOT_BYTES) throw new Error("Context note snapshot exceeds the 10,000,000-byte limit");
}

export function createLocalContext(identity: LocalContextIdentity, messages: readonly Message[] = []): LocalContextState {
	const state: LocalContextState = {
		version: 1,
		identity: clone(identity),
		activeWindowId: randomUUID(),
		activeMessages: [],
		activeItems: [],
		archives: [],
		notes: [],
	};
	replaceActiveMessages(state, messages);
	return state;
}

export function parseLocalContext(value: unknown): LocalContextState {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.identity) || typeof value.identity.branchId !== "string" || !value.identity.branchId || typeof value.identity.preset !== "string" || !value.identity.preset || typeof value.identity.role !== "string" || !value.identity.role || !isId(value.activeWindowId) || !Array.isArray(value.activeMessages) || !Array.isArray(value.archives) || !Array.isArray(value.notes))
		throw new Error("Invalid local context v1 state");
	if (!value.activeMessages.every(validMessage)) throw new Error("Invalid local context v1 active messages");
	const activeItems = value.activeItems === undefined
		? value.activeMessages.map(message => itemFromMessage(message))
		: value.activeItems;
	if (!Array.isArray(activeItems) || activeItems.length !== value.activeMessages.length) throw new Error("Invalid local context v1 active item projection");
	for (const item of activeItems) validateItem(item);
	validateProjection(value.activeMessages, activeItems);
	const ids = new Set(activeItems.map((item) => item.id));
	if (ids.size !== activeItems.length) throw new Error("Duplicate local context v1 item ID");
	const windowIds = new Set<string>([value.activeWindowId]);
	for (const window of value.archives) {
		if (!isRecord(window) || !isId(window.id) || windowIds.has(window.id) || !Array.isArray(window.items) || window.summary !== undefined && typeof window.summary !== "string") throw new Error("Invalid local context v1 archive");
		if (!Array.isArray(window.messages) || window.messages.length !== window.items.length || !window.messages.every(validMessage)) throw new Error("Invalid local context v1 archived messages");
		windowIds.add(window.id);
		for (const item of window.items) validateItem(item);
		validateProjection(window.messages, window.items);
	}
	const itemIds = new Set<string>();
	for (const window of value.archives) for (const item of window.items) {
		if (itemIds.has(item.id)) throw new Error("Duplicate local context v1 item ID");
		itemIds.add(item.id);
	}
	for (const item of activeItems) {
		if (itemIds.has(item.id)) throw new Error("Duplicate local context v1 item ID");
		itemIds.add(item.id);
	}
	validateNotes(value.notes, value.identity.role);
	if (value.pending !== undefined && (!isRecord(value.pending) || !isId(value.pending.fromWindowId) || !isId(value.pending.toWindowId) || typeof value.pending.requestedAt !== "number" || !Number.isFinite(value.pending.requestedAt) || value.pending.fromWindowId !== value.activeWindowId || windowIds.has(value.pending.toWindowId)))
		throw new Error("Invalid local context v1 pending transition");
	const state = clone(value) as unknown as LocalContextState;
	state.activeItems = clone(activeItems);
	return state;
}

export function serializeLocalContext(state: LocalContextState): LocalContextState {
	return parseLocalContext(state);
}

export function replaceActiveMessages(state: LocalContextState, messages: readonly Message[]): void {
	const existing = new Map<string, LocalContextItem[]>();
	for (const [index, message] of state.activeMessages.entries()) {
		const item = state.activeItems[index];
		if (!item) continue;
		const key = JSON.stringify(message);
		const items = existing.get(key) ?? [];
		items.push(item);
		existing.set(key, items);
	}
	const nextMessages = clone([...messages]);
	const nextItems = nextMessages.map(message => clone(existing.get(JSON.stringify(message))?.shift() ?? itemFromMessage(message)));
	state.activeMessages = nextMessages;
	state.activeItems = nextItems;
}

// Keep full tool batches together. A pending call is never silently dropped or replayed.
export function messageGroups(messages: readonly Message[]): Message[][] {
	const groups: Message[][] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && groups.length) groups.at(-1)!.push(message);
		else groups.push([message]);
	}
	return groups;
}
export function interruptPending(messages: Message[]): boolean {
	let changed = false;
	const paired: Message[] = [];
	for (const group of messageGroups(messages)) {
		paired.push(...group);
		const assistant = group[0];
		if (assistant.role !== "assistant") continue;
		for (const call of assistant.content.filter(block => block.type === "toolCall")) {
			if (group.some(message => message.role === "toolResult" && message.toolCallId === call.id)) continue;
			paired.push({ role: "toolResult", toolName: call.name, toolCallId: call.id, timestamp: Date.now(), isError: true,
				content: [{ type: "text", text: "Interrupted: no result was recorded. The operation may have changed files. Inspect the current checkout before continuing; never replay this call automatically." }] });
			changed = true;
		}
	}
	if (changed) messages.splice(0, messages.length, ...paired);
	return changed;
}

export function reconcileLocalContext(state: LocalContextState, currentTask?: Message): boolean {
	const messages = clone(state.activeMessages);
	const interrupted = interruptPending(messages);
	if (interrupted) replaceActiveMessages(state, messages);
	if (!state.pending) return interrupted;
	const group = messageGroups(state.activeMessages).findLast(group => group[0].role === "assistant" && group[0].content.some(block => block.type === "toolCall" && block.name === "new_context"));
	const assistant = group?.[0];
	const call = assistant?.role === "assistant" ? assistant.content.find(block => block.type === "toolCall" && block.name === "new_context") : undefined;
	const accepted = call?.type === "toolCall" && group?.some(message => message.role === "toolResult" && message.toolCallId === call.id && !message.isError);
	if (accepted && assistant) commitContextTransition(state, { currentTask, boundaryGroup: state.activeMessages.slice(state.activeMessages.indexOf(assistant)) });
	else cancelContextTransition(state);
	return interrupted;
}

export function appendActiveMessage(state: LocalContextState, message: Message): LocalContextItem {
	const nextMessage = clone(message);
	const nextItem = itemFromMessage(nextMessage);
	state.activeMessages.push(nextMessage);
	state.activeItems.push(nextItem);
	return clone(nextItem);
}

export function scheduleContextTransition(state: LocalContextState, now = Date.now()): LocalContextTransition {
	if (state.pending) return clone(state.pending);
	state.pending = { fromWindowId: state.activeWindowId, toWindowId: randomUUID(), requestedAt: now };
	return clone(state.pending);
}

export function cancelContextTransition(state: LocalContextState): void {
	delete state.pending;
}

export function commitContextTransition(state: LocalContextState, options: {
	summary?: string;
	currentTask?: Message;
	boundaryGroup?: readonly Message[];
	notesPrompt?: Message;
} = {}): boolean {
	const pending = state.pending;
	if (!pending || pending.fromWindowId !== state.activeWindowId) return false;
	const notesPrompt: Message | undefined = options.notesPrompt ?? (state.notes.length ? {
		role: "user", timestamp: pending.requestedAt,
		content: `Local notes for ${state.identity.role}:\n${state.notes.map(note => `${note.path}\n${note.text}`).join("\n\n")}`,
	} : undefined);
	const nextMessages = [notesPrompt, options.currentTask, ...(options.boundaryGroup ?? [])].filter((message): message is Message => message !== undefined).map(clone);
	const nextItems = nextMessages.map(message => itemFromMessage(message));
	const archive: LocalContextWindow = {
		id: state.activeWindowId,
		items: clone(state.activeItems),
		messages: clone(state.activeMessages),
		...(options.summary ? { summary: options.summary } : {}),
	};
	state.archives.push(archive);
	state.activeWindowId = pending.toWindowId;
	state.activeMessages = nextMessages;
	state.activeItems = nextItems;
	delete state.pending;
	return true;
}

export function detachedContextSnapshot(state: LocalContextState): LocalContextState {
	return serializeLocalContext(state);
}

function agentName(role: string): string {
	return role.replace(/^\/+/, "").replaceAll("/", "-");
}

function noteRoot(role: string): string {
	return `/${agentName(role)}/notes`;
}

function notePath(value: unknown, role: string, prefix = false): string {
	const root = noteRoot(role);
	if (value === undefined || value === null || value === "") return `${root}/`;
	if (typeof value !== "string") throw new Error(prefix ? "Note prefix must be a string" : "Note file path is required");
	const path = value.startsWith("/") ? value : `${root}/${value}`;
	const components = path.slice(1).split("/");
	if (components.some((component) => !component || component === "." || component === "..")) throw new Error(`Note ${prefix ? "prefixes" : "paths"} cannot contain empty, . or .. components`);
	const expected = `${agentName(role)}/notes`;
	if (components.length < 2 || components[0] !== agentName(role) || components[1] !== "notes") throw new Error("Cross-role note access is not allowed");
	if (components.length === 2) {
		if (!prefix) throw new Error("Absolute note paths must use <agent>/notes/<path>");
		return `${path}/`;
	}
	if (!path.startsWith(`/${expected}/`)) throw new Error("Cross-role note access is not allowed");
	return path;
}

function currentAgent(value: unknown, identity: LocalContextIdentity): boolean {
	const current = agentName(identity.role);
	return value === undefined || value === null || value === "" || value === current || value === `/${current}`;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
	return typeof value === "number" && Number.isInteger(value) ? Math.max(0, Math.min(value, maximum)) : fallback;
}

function historyWindows(state: LocalContextState): LocalContextWindow[] {
	return [...state.archives, { id: state.activeWindowId, items: clone(state.activeItems), messages: clone(state.activeMessages) }];
}

function historyItemPreview(item: LocalContextItem & { windowId: string; maxChars: number }): Record<string, unknown> {
	return {
		window_id: item.windowId,
		item_id: item.id,
		role: item.role,
		...(item.toolName ? { tool_name: item.toolName } : {}),
		...(item.toolNamespace ? { tool_namespace: item.toolNamespace } : {}),
		truncated_content: item.content.slice(0, item.maxChars),
		content_chars: item.content.length,
	};
}

type IndexedItem = LocalContextItem & { windowId: string; maxChars: number };

export function localHistory(state: LocalContextState, action: HistoryAction, params: Record<string, unknown>): Record<string, unknown> {
	if (!currentAgent(params.agent_name, state.identity)) return action === "list_windows" ? { windows: [] } : { items: [] };
	const windows = historyWindows(state);
	if (action === "list_windows") {
		const ordered = params.recent_first === true ? [...windows].reverse() : windows;
		return { source: "pi-session", windows: ordered.slice(0, boundedInteger(params.limit, 20, 100)).map((window) => ({ window_id: window.id, item_count: window.items.length })) };
	}
	if (action === "read_item") {
		const windowId = typeof params.window_id === "string" ? params.window_id : "";
		const itemId = typeof params.item_id === "string" ? params.item_id : "";
		const found = windows.find((window) => window.id === windowId)?.items.find((item) => item.id === itemId || item.id.endsWith(itemId));
		if (!found) return { source: "pi-session", item: null };
		const offset = boundedInteger(params.offset_chars, 0, found.content.length);
		const limit = boundedInteger(params.limit_chars, READ_ITEM_LIMIT_CHARS, READ_ITEM_LIMIT_CHARS);
		const content = found.content.slice(offset, offset + limit);
		return { source: "pi-session", item: { window_id: windowId, item_id: found.id, role: found.role, ...(found.toolName ? { tool_name: found.toolName } : {}), ...(found.toolNamespace ? { tool_namespace: found.toolNamespace } : {}), content, total_chars: found.content.length, ...(offset + content.length < found.content.length ? { next_offset_chars: offset + content.length } : {}) } };
	}
	const query = action === "search_contents" ? (typeof params.query === "string" ? params.query : "") : undefined;
	let items: IndexedItem[] = windows.flatMap((window) => window.items.map((item) => ({ ...item, windowId: window.id, maxChars: boundedInteger(params.max_chars_per_item, LIST_ITEM_PREVIEW_CHARS, LIST_ITEM_PREVIEW_CHARS) })));
	const windowId = typeof params.window_id === "string" && params.window_id ? params.window_id : undefined;
	if (windowId) items = items.filter((item) => item.windowId === windowId);
	const role = typeof params.role === "string" && params.role ? params.role : undefined;
	if (role) items = items.filter((item) => item.role === role);
	const toolName = typeof params.tool_name === "string" && params.tool_name ? params.tool_name : undefined;
	if (toolName) items = items.filter((item) => item.toolName === toolName);
	const toolNamespace = typeof params.tool_namespace === "string" && params.tool_namespace ? params.tool_namespace : undefined;
	if (toolNamespace) items = items.filter((item) => item.toolNamespace === toolNamespace);
	if (query !== undefined) items = items.filter((item) => item.content.includes(query));
	if (params.recent_first === true) items.reverse();
	const output: Record<string, unknown>[] = [];
	let size = 0;
	for (const item of items.slice(0, boundedInteger(params.limit, 10, LIST_ITEM_LIMIT))) {
		const preview = historyItemPreview(item);
		const previewSize = JSON.stringify(preview).length;
		if (output.length > 0 && size + previewSize > LIST_OUTPUT_LIMIT_CHARS) break;
		output.push(preview);
		size += previewSize;
	}
	return { source: "pi-session", items: output };
}

function noteMetadata(note: LocalContextNote): Record<string, unknown> {
	return {
		path: note.path,
		bytes: Buffer.byteLength(note.text, "utf8"),
		created_at: new Date(note.createdAt).toISOString(),
		updated_at: new Date(note.updatedAt).toISOString(),
	};
}

function lineIndex(value: unknown, lineCount: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value === 0) return fallback;
	const index = value > 0 ? value - 1 : lineCount + value;
	return Math.max(0, Math.min(index, Math.max(0, lineCount - 1)));
}

export function localNotes(state: LocalContextState, action: NotesAction, params: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
	if (action === "list_files_by_prefix") {
		const prefix = notePath(params.prefix, state.identity.role, true);
		const orderBy = params.file_order_by === "created_at" || params.file_order_by === "updated_at" ? params.file_order_by : "name";
		const direction = params.file_order === "descending" ? -1 : 1;
		const files = state.notes.filter((note) => note.path.startsWith(prefix)).sort((left, right) => {
			const compared = orderBy === "name" ? left.path.localeCompare(right.path) : orderBy === "created_at" ? left.createdAt - right.createdAt : left.updatedAt - right.updatedAt;
			return compared * direction;
		}).slice(0, boundedInteger(params.max_results, 20, 100)).map(noteMetadata);
		return { source: "pi-session", files };
	}
	if (action === "search_contents") {
		if (typeof params.query !== "string" || params.query === "") throw new Error("notes search_contents requires query");
		const prefix = notePath(params.path_prefix, state.identity.role, true);
		const candidates = state.notes.filter((note) => note.path.startsWith(prefix)).sort((left, right) => params.recent_file_first === true ? right.createdAt - left.createdAt : left.path.localeCompare(right.path));
		const files: Record<string, unknown>[] = [];
		for (const note of candidates) {
			const matches = note.text.split("\n").map((line, index) => ({ line_number: index + 1, line })).filter(({ line }) => line.includes(params.query as string)).slice(0, boundedInteger(params.max_matches_per_file, 20, 100));
			if (!matches.length) continue;
			files.push({ path: note.path, matches });
			if (files.length >= boundedInteger(params.max_files, 20, 100)) break;
		}
		return { source: "pi-session", files };
	}
	const path = notePath(params.path, state.identity.role);
	const existing = state.notes.find((note) => note.path === path);
	if (action === "read_file") {
		if (!existing) return { source: "pi-session", file: null };
		const lines = existing.text.split("\n");
		const start = lineIndex(params.start_line, lines.length, 0);
		const stop = lineIndex(params.stop_line, lines.length, lines.length - 1);
		return { source: "pi-session", file: { ...noteMetadata(existing), content: start <= stop ? lines.slice(start, stop + 1).join("\n") : "", start_line: start + 1, stop_line: Math.max(start, stop) + 1, total_lines: lines.length } };
	}
	if (typeof params.text !== "string") throw new Error(`notes ${action} requires text`);
	const nextText = action === "append_to_file" ? `${existing?.text ?? ""}${params.text}` : params.text;
	if (Buffer.byteLength(nextText, "utf8") > MAX_NOTE_FILE_BYTES) throw new Error("Note file exceeds the 1,000,000-byte limit");
	const nextNote: LocalContextNote = { path, text: nextText, createdAt: existing?.createdAt ?? now, updatedAt: now };
	const nextNotes = existing ? state.notes.map((note) => note.path === path ? nextNote : note) : [...state.notes, nextNote];
	if (noteSnapshotBytes(nextNotes) > MAX_NOTE_SNAPSHOT_BYTES) throw new Error("Context note snapshot exceeds the 10,000,000-byte limit");
	state.notes = nextNotes;
	return { source: "pi-session", file: noteMetadata(nextNote) };
}

export function contextRemaining(state: LocalContextState, contextWindow: number, reserveTokens: number, usedTokens?: number): RemainingContext {
	const limit = Math.max(0, contextWindow - Math.max(0, reserveTokens));
	const remainingTokens = usedTokens === undefined ? undefined : Math.max(0, limit - usedTokens);
	return {
		remainingTokens,
		windowId: state.activeWindowId,
		contextWindow: limit,
		...(remainingTokens === 0 ? {
			budgetStatus: "exhausted" as const,
			guidance: "Zero local context budget does not disable tools. Continue the requested operation after the runtime compacts or changes the active context window.",
		} : {}),
	};
}
