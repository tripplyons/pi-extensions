import { createHash, randomUUID } from "node:crypto";
import type { Api, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "@howaboua/pi-codex-conversion/dist/adapter/activation/config-contract.js";
import { buildRequestBody } from "@howaboua/pi-codex-conversion/dist/providers/openai-codex/request-body.js";
import { createCodexTransportStream } from "@howaboua/pi-codex-conversion/dist/providers/openai-codex/transport-recovery.js";
import { normalizeResponsesToolHistory } from "@howaboua/pi-codex-conversion/dist/providers/openai-responses/tool-history.js";
import { normalizeCodexConfigurationUpdates } from "@howaboua/pi-codex-conversion/dist/adapter/reasoning-updates.js";
import { hasContextNamespaceRouters, rewriteContextNamespaceTools, routeContextNamespaceToolStream } from "@howaboua/pi-codex-conversion/dist/context-management/namespace-tools.js";
import type { OpenAICodexStreamOptions, ResponsesBody } from "@howaboua/pi-codex-conversion/dist/providers/openai-codex/types.js";

// Transport policy is independent of the upstream singleton and user defaults.
const localConfig = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
localConfig.executionMode = "normal";
localConfig.compaction = { ...localConfig.compaction, contextManagement: "off", hybridCompaction: false, responsesCompaction: false, portableSummary: false };
localConfig.openai = { ...localConfig.openai, proxyResponsesLite: false, forceCachedWebSockets: false, cacheKeepalive: false, lunaCacheKeepaliveMinutes: 0, cacheDiagnostics: "off" };
function freezeConfig(value: object) {
	for (const child of Object.values(value)) if (child && typeof child === "object") freezeConfig(child);
	Object.freeze(value);
}
freezeConfig(localConfig);
export const LOCAL_CODEX_CONFIG = localConfig;

const PROHIBITED_HEADERS = new Set([
	"x-codex-beta-features",
	"x-codex-turn-state",
	"x-codex-window-id",
	"x-codex-turn-metadata",
	"x-openai-encrypted-tool-arguments",
	"x-openai-tool-output-truncation-policy",
	"x-openai-internal-codex-responses-lite",
]);
const PROHIBITED_BODY_FIELDS = new Set([
	"previous_response_id",
	"compaction_trigger",
	"context_management",
	"truncation",
	"history_ingest_requested",
	"context_window_id",
	"window_id",
	"x-codex-window-id",
	"x-codex-turn-metadata",
	"x-codex-turn-state",
	"additional_tools",
	"ws_request_header_x_openai_internal_codex_responses_lite",
]);
const activeLaneReleases = new Map<string, Set<() => void>>();

function acquireLocalLane(id: string, cancel: () => void): () => void {
	const releases = activeLaneReleases.get(id) ?? new Set<() => void>();
	activeLaneReleases.set(id, releases);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		releases.delete(close);
		if (!releases.size) activeLaneReleases.delete(id);
	};
	const close = () => { cancel(); release(); };
	releases.add(close);
	return release;
}

export function releaseLocalCodexLanes(ids?: readonly string[]) {
	const selected = ids ? [...new Set(ids)] : [...activeLaneReleases.keys()];
	for (const id of selected) for (const release of [...(activeLaneReleases.get(id) ?? [])]) release();
}

const PROHIBITED_METADATA_FIELDS = new Set([
	"x-codex-turn-state",
	"x-codex-window-id",
	"x-codex-turn-metadata",
	"history_ingest_requested",
	"context_window_id",
	"window_id",
	"compaction_trigger",
	"ws_request_header_x_openai_internal_codex_responses_lite",
]);

type LocalProviderOptions = SimpleStreamOptions & OpenAICodexStreamOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function laneId(sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	return `local-${createHash("sha256").update(`pi-codex-local-context-v1\0${sessionId}`).digest("hex")}`;
}

export function codexLocalLaneId(sessionId: string | undefined): string | undefined {
	return laneId(sessionId);
}

export function sanitizeCodexHeaders<T extends Record<string, string | null>>(headers: T | undefined): T | undefined {
	if (!headers) return undefined;
	const result = { ...headers } as T;
	for (const key of Object.keys(result)) if (PROHIBITED_HEADERS.has(key.toLowerCase())) delete result[key];
	return result;
}

function normalizeLocalCorrelation(body: ResponsesBody, id: string | undefined): ResponsesBody {
	if (!id) return body;
	const metadata = isRecord(body.client_metadata) ? { ...body.client_metadata } : {};
	metadata.session_id = id;
	metadata.thread_id = id;
	return { ...body, prompt_cache_key: id, client_metadata: metadata };
}

function hasForbiddenInput(value: unknown, path: string): string | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.type === "string" && ["compaction", "compaction_trigger", "item_reference", "additional_tools"].includes(value.type)) return `${path}.type`;
	for (const [key, child] of Object.entries(value)) {
		const normalized = key.toLowerCase();
		if (PROHIBITED_BODY_FIELDS.has(normalized)) return `${path}.${key}`;
		if (key === "content" || key === "text" || key === "arguments" || key === "output") continue;
		const nested = hasForbiddenInput(child, `${path}.${key}`);
		if (nested) return nested;
	}
	return undefined;
}

function jsonEqual(left: unknown, right: unknown): boolean {
	try { return JSON.stringify(left) === JSON.stringify(right); }
	catch { return false; }
}

/**
 * The upstream request hook still carries voice, tier and developer-message
 * behavior. Remove only state that that known hook generated; later callbacks
 * remain visible to the final guard and cannot smuggle state onto the wire.
 */
export function sanitizeNativeCodexPayload(original: unknown, candidate: unknown): unknown {
	if (!isRecord(candidate)) return candidate;
	const source = isRecord(original) ? original : {};
	let result: Record<string, unknown> = { ...candidate };
	const hadLiteMarker = Array.isArray(candidate.input) && candidate.input.some(item => isRecord(item) && item.type === "additional_tools");
	for (const field of PROHIBITED_BODY_FIELDS) if (!Object.hasOwn(source, field)) delete result[field];
	if (!Object.hasOwn(source, "instructions") && hadLiteMarker) delete result.instructions;
	if (hadLiteMarker) {
		if (Object.hasOwn(source, "instructions")) result.instructions = source.instructions;
		if (Object.hasOwn(source, "tools")) result.tools = source.tools;
		if (Object.hasOwn(source, "reasoning")) result.reasoning = source.reasoning;
		if (Array.isArray(source.input)) result.input = source.input;
	}
	if (isRecord(result.client_metadata)) {
		const sourceMetadata = isRecord(source.client_metadata) ? source.client_metadata : {};
		const metadata = Object.fromEntries(Object.entries(result.client_metadata).filter(([key]) => !PROHIBITED_METADATA_FIELDS.has(key.toLowerCase()) || Object.hasOwn(sourceMetadata, key)));
		if (Object.keys(metadata).length || Object.hasOwn(source, "client_metadata")) result.client_metadata = metadata;
		else delete result.client_metadata;
	}
	if (Array.isArray(result.input) && Array.isArray(source.input)) {
		result.input = result.input.filter(item => {
			if (!isRecord(item) || !["compaction_trigger", "additional_tools"].includes(String(item.type))) return true;
			return source.input.some(sourceItem => jsonEqual(sourceItem, item));
		});
	}
	if (isRecord(result.reasoning) && Object.hasOwn(result.reasoning, "context") && !(isRecord(source.reasoning) && Object.hasOwn(source.reasoning, "context"))) {
		const { context: _context, ...reasoning } = result.reasoning;
		if (Object.keys(reasoning).length) result.reasoning = reasoning;
		else if (!Object.hasOwn(source, "reasoning")) delete result.reasoning;
	}
	return rewriteContextNamespaceTools(result, { encrypted: false });
}

export function assertLocalCodexBody(body: unknown): asserts body is ResponsesBody {
	if (!isRecord(body)) throw new Error("Local Codex request must be an object");
	for (const field of Object.keys(body)) if (PROHIBITED_BODY_FIELDS.has(field.toLowerCase())) throw new Error(`Local Codex request contains prohibited field: ${field}`);
	if (Array.isArray(body.input)) {
		const forbidden = body.input.map((item, index) => hasForbiddenInput(item, `input[${index}]`)).find(Boolean);
		if (forbidden) throw new Error(`Local Codex request contains prohibited state at ${forbidden}`);
	}
	if (isRecord(body.client_metadata)) {
		for (const key of Object.keys(body.client_metadata)) if (PROHIBITED_METADATA_FIELDS.has(key.toLowerCase())) throw new Error(`Local Codex request contains prohibited metadata: ${key}`);
	}
	if (isRecord(body.reasoning) && Object.hasOwn(body.reasoning, "context")) throw new Error("Local Codex request contains prohibited Responses Lite reasoning context");
}

export async function prepareLocalCodexRequestBody<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: OpenAICodexStreamOptions | undefined,
): Promise<ResponsesBody> {
	const id = laneId(options?.sessionId);
	const localOptions = options ? {
		...options,
		...(id ? { sessionId: id } : {}),
		transport: "sse" as const,
		canonicalCompaction: false,
		responsesLite: false,
		headers: sanitizeCodexHeaders(options.headers),
	} : { transport: "sse" as const, canonicalCompaction: false, responsesLite: false };
	let body = buildRequestBody(model, context, localOptions);
	const nextBody = await options?.onPayload?.(body, model);
	if (nextBody !== undefined) body = nextBody as ResponsesBody;
	// Reject injected state before history normalization can discard malformed items.
	assertLocalCodexBody(body);
	if (!body.previous_response_id) {
		const input = normalizeResponsesToolHistory(body.input ?? []);
		if (input !== body.input) body = { ...body, input };
	}
	body = normalizeCodexConfigurationUpdates(body);
	body = normalizeLocalCorrelation(body, id);
	assertLocalCodexBody(body);
	return body;
}

function localModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	const headers = sanitizeCodexHeaders(model.headers);
	return headers ? { ...model, headers: headers as Record<string, string> } : model;
}

function localOptions(options: LocalProviderOptions | undefined): OpenAICodexStreamOptions | undefined {
	if (!options) return { transport: "sse", canonicalCompaction: false, responsesLite: false };
	const id = laneId(options.sessionId);
	return {
		...options,
		...(id ? { sessionId: id } : {}),
		transport: "sse",
		canonicalCompaction: false,
		responsesLite: false,
		headers: sanitizeCodexHeaders(options.headers),
	};
}

type AcquireLane = (id: string, cancel: () => void) => () => void;

export function localCodexStream<TApi extends Api>(model: Model<TApi>, context: Context, options?: LocalProviderOptions, assertPolicy: () => void = () => {}, acquire?: AcquireLane) {
	const requestSessionId = options?.sessionId ?? `local-request/${randomUUID()}`;
	const controller = new AbortController();
	const cancel = () => controller.abort(new Error("Local Codex request lane released"));
	const release = acquireLocalLane(requestSessionId, cancel);
	const releaseOwner = acquire?.(requestSessionId, cancel);
	const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const requestOptions = { ...(options ?? {}), sessionId: requestSessionId, signal } as LocalProviderOptions;
	try {
		const source = createCodexTransportStream(localModel(model), context, localOptions(requestOptions), {
			prepareRequestBody: (model, context, options) => {
				assertPolicy();
				return prepareLocalCodexRequestBody(model, context, { ...options, sessionId: requestSessionId });
			},
			getConfig: () => LOCAL_CODEX_CONFIG,
			useResponsesLite: () => false,
		});
		const output = hasContextNamespaceRouters(context) ? routeContextNamespaceToolStream(source) : source;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			release();
			releaseOwner?.();
			requestOptions.signal?.removeEventListener("abort", finish);
		};
		if (signal.aborted) finish();
		else signal.addEventListener("abort", finish, { once: true });
		void output.result().then(finish, finish);
		return output;
	} catch (error) {
		release();
		releaseOwner?.();
		throw error;
	}
}

export function wrapLocalCodexProvider(provider: Provider, assertPolicy?: () => void, acquire?: AcquireLane): Provider {
	if (provider.id !== "openai-codex") return provider;
	const stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => localCodexStream(model, context, options as LocalProviderOptions, assertPolicy, acquire);
	return { ...provider, stream, streamSimple: stream };
}

export function preserveLocalCodexProvider(pi: ExtensionAPI, assertPolicy?: () => void, acquire?: AcquireLane): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property !== "registerProvider") return Reflect.get(target, property, receiver);
			return (provider: Provider) => target.registerProvider(wrapLocalCodexProvider(provider, assertPolicy, acquire));
		},
	});
}
