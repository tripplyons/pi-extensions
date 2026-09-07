import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { compressionMode } from "../context-compression/core.ts";
import {
	buildCodexHeaders,
	buildCompactionRequestBody,
	CODEX_CLIENT_VERSION,
	buildReplacementHistory,
	buildToolPayload,
	callRemoteCompaction,
	effectiveInputForBranch,
	findNativeCheckpoint,
	isJsonObject,
	isOpenAICodexModel,
	mergeFeatureHeader,
	modelKey,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	REMOTE_COMPACTION_TIMEOUT_MS,
	resolveCodexResponsesUrl,
	stripInputFromPayload,
	type JsonObject,
	type NativeCompactionDetails,
	type ResponseItem,
} from "./native-compaction.ts";
import {
	CODEX_COMPACTION_CAPABILITY_EVENT,
	CODEX_COMPACTION_COMMITTED_EVENT,
	CODEX_COMPACTION_FAILED_EVENT,
	CODEX_COMPACTION_STARTED_EVENT,
	type CodexCompactionCapabilityQuery,
	type CodexCompactionCommitted,
	type CodexCompactionFailed,
	type CodexCompactionReason,
	type CodexCompactionStarted,
} from "./protocol.ts";

type CachedPayloadShape = {
	modelKey: string;
	payload: JsonObject;
};

type CompactionTransaction = CodexCompactionStarted & {
	phase: "requesting" | "prepared";
	failureMessage?: string;
};

const STATUS_ID = "codex-compaction";
const THRESHOLD_STATE_ENTRY = "codex-compaction-threshold-state";
const DEFAULT_THRESHOLD_TOKENS = 200_000;
const ASTRA_DEFAULT_THRESHOLD_TOKENS = 150_000;

function defaultThresholdTokens(model: ExtensionContext["model"]): number {
	return isOpenAICodexModel(model) && model.id === "gpt-6-astra"
		? ASTRA_DEFAULT_THRESHOLD_TOKENS
		: DEFAULT_THRESHOLD_TOKENS;
}

type StoredThresholdEntry = {
	type?: string;
	customType?: string;
	data?: { tokens?: unknown };
};

function readStoredThreshold(entries: StoredThresholdEntry[]): number | undefined {
	let threshold: number | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== THRESHOLD_STATE_ENTRY) continue;
		if (typeof entry.data?.tokens === "number" && Number.isSafeInteger(entry.data.tokens) && entry.data.tokens > 0) {
			threshold = entry.data.tokens;
		}
	}
	return threshold;
}

function formatTokenCount(tokens: number): string {
	return tokens.toLocaleString("en-US");
}

function parseTokenCount(input: string): number | undefined {
	const match = input.trim().toLowerCase().replaceAll(/[, _]/g, "").match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!match) return undefined;
	const scale = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
	const tokens = Number(match[1]) * scale;
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function localMarker(): string {
	return `OpenAI Codex native compaction checkpoint (${randomUUID()}).`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function setFeatureHeader(headers: Record<string, string | null>): void {
	const existing = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-codex-beta-features");
	if (existing) headers[existing[0]] = mergeFeatureHeader(existing[1]);
	else headers["x-codex-beta-features"] = mergeFeatureHeader(undefined);
}

function setHeaderIfMissing(headers: Record<string, string | null>, name: string, value: string): void {
	if (Object.keys(headers).some((candidate) => candidate.toLowerCase() === name.toLowerCase())) return;
	headers[name] = value;
}

export default function codexCompactionExtension(pi: ExtensionAPI): void {
	pi.events.on(CODEX_COMPACTION_CAPABILITY_EVENT, (value: unknown) => {
		if (!isJsonObject(value)) return;
		const query = value as CodexCompactionCapabilityQuery;
		if (query.provider === "openai-codex" && query.api === "openai-codex-responses") query.available = true;
	});

	const payloadShapeBySession = new Map<string, CachedPayloadShape>();
	const thresholdBySession = new Map<string, number>();
	const scheduledSessions = new Set<string>();
	let transaction: CompactionTransaction | undefined;
	let progressTimer: ReturnType<typeof setInterval> | undefined;
	let progressStartedAt = 0;
	let sessionGeneration = 0;

	const stopProgressTimer = (): void => {
		if (progressTimer === undefined) return;
		clearInterval(progressTimer);
		progressTimer = undefined;
	};

	const clearStatus = (ctx: ExtensionContext): void => {
		stopProgressTimer();
		progressStartedAt = 0;
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_ID, undefined);
		ctx.ui.setWidget(STATUS_ID, undefined);
	};

	const showProgress = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const elapsedSeconds = Math.floor((Date.now() - progressStartedAt) / 1000);
		const timeoutSeconds = Math.ceil(REMOTE_COMPACTION_TIMEOUT_MS / 1000);
		const message = `Codex compaction: waiting for OpenAI — ${elapsedSeconds}s elapsed (${timeoutSeconds}s timeout)`;
		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `Codex compacting ${elapsedSeconds}s`));
		ctx.ui.setWidget(STATUS_ID, [ctx.ui.theme.fg("dim", message)], { placement: "aboveEditor" });
	};

	const beginTransaction = (
		ctx: ExtensionContext,
		reason: CodexCompactionReason,
		sourceLeafId: string,
	): CompactionTransaction => {
		if (transaction) throw new Error("A Codex compaction transaction is already active.");
		const started: CodexCompactionStarted = {
			transactionId: randomUUID(),
			checkpointId: randomUUID(),
			sessionId: ctx.sessionManager.getSessionId(),
			reason,
			sourceLeafId,
		};
		transaction = { ...started, phase: "requesting" };
		pi.events.emit(CODEX_COMPACTION_STARTED_EVENT, started);
		progressStartedAt = Date.now();
		showProgress(ctx);
		progressTimer = setInterval(() => showProgress(ctx), 1000);
		return transaction;
	};

	const finishFailed = (ctx: ExtensionContext, state: CompactionTransaction, error?: string): void => {
		if (transaction !== state) return;
		transaction = undefined;
		clearStatus(ctx);
		pi.events.emit(CODEX_COMPACTION_FAILED_EVENT, {
			transactionId: state.transactionId,
			checkpointId: state.checkpointId,
			sessionId: state.sessionId,
			reason: state.reason,
			sourceLeafId: state.sourceLeafId,
			...(error ? { error } : {}),
		} satisfies CodexCompactionFailed);
	};

	const scheduleThresholdCompaction = (ctx: ExtensionContext, continueTurn = false): void => {
		const sessionId = ctx.sessionManager.getSessionId();
		const threshold = thresholdBySession.get(sessionId)
			?? (isOpenAICodexModel(ctx.model) ? defaultThresholdTokens(ctx.model) : undefined);
		const usage = ctx.getContextUsage();
		if (
			threshold === undefined
			|| usage?.tokens === null
			|| usage?.tokens === undefined
			|| usage.tokens < threshold
			|| transaction !== undefined
			|| scheduledSessions.has(sessionId)
		) return;

		scheduledSessions.add(sessionId);
		const generation = sessionGeneration;
		ctx.compact({
			onComplete: () => {
				if (generation !== sessionGeneration || sessionId !== ctx.sessionManager.getSessionId()) return;
				scheduledSessions.delete(sessionId);
				if (!continueTurn || ctx.hasPendingMessages()) return;
				pi.sendMessage({
					customType: "codex-compaction-continuation",
					content: "Automatic compaction completed. Continue the current task from the completed tool results. Do not repeat completed work.",
					display: false,
				}, { triggerTurn: true, deliverAs: "followUp" });
			},
			onError: (error) => {
				scheduledSessions.delete(sessionId);
				if (ctx.hasUI) ctx.ui.notify(`Threshold compaction failed: ${errorMessage(error)}`, "error");
			},
		});
	};

	const createNativeCheckpoint = async (params: {
		ctx: ExtensionContext;
		model: Model<any>;
		input: ResponseItem[];
		transaction: CompactionTransaction;
		basePayload?: JsonObject;
		signal?: AbortSignal;
	}): Promise<{ details: NativeCompactionDetails; usage?: Awaited<ReturnType<typeof callRemoteCompaction>>["usage"] }> => {
		const auth = await params.ctx.modelRegistry.getApiKeyAndHeaders(params.model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error(auth.ok ? "OpenAI Codex authentication is unavailable." : auth.error);
		}
		const body = buildCompactionRequestBody({
			basePayload: params.basePayload,
			model: params.model,
			input: params.input,
			instructions: params.ctx.getSystemPrompt(),
			tools: params.basePayload
				? undefined
				: buildToolPayload(pi.getAllTools(), pi.getActiveTools()),
			sessionId: params.transaction.sessionId,
		});
		const remote = await callRemoteCompaction({
			url: resolveCodexResponsesUrl(params.model.baseUrl),
			headers: buildCodexHeaders({
				apiKey: auth.apiKey,
				headers: auth.headers,
				sessionId: params.transaction.sessionId,
				modelId: params.model.id,
				serviceTier: typeof body.service_tier === "string" ? body.service_tier : undefined,
			}),
			body,
			model: params.model,
			signal: params.signal,
		});
		return {
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				checkpointId: params.transaction.checkpointId,
				sessionId: params.transaction.sessionId,
				sourceLeafId: params.transaction.sourceLeafId,
				modelKey: modelKey(params.model),
				replacementHistory: buildReplacementHistory(params.input, remote.compactionItem),
			},
			usage: remote.usage,
		};
	};

	pi.registerCommand("threshold", {
		description: "Show or change this session's compaction threshold",
		handler: async (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!args.trim()) {
				const threshold = thresholdBySession.get(sessionId) ?? defaultThresholdTokens(ctx.model);
				const source = thresholdBySession.has(sessionId) ? "session override" : "default";
				ctx.ui.notify(`Compaction threshold: ${formatTokenCount(threshold)} tokens (${source}).`, "info");
				return;
			}

			const threshold = parseTokenCount(args);
			if (threshold === undefined) {
				ctx.ui.notify("Usage: /threshold <tokens>, for example /threshold 180k.", "error");
				return;
			}
			if (threshold >= ctx.model.contextWindow) {
				ctx.ui.notify(
					`Threshold must be below this model's ${formatTokenCount(ctx.model.contextWindow)}-token context window.`,
					"error",
				);
				return;
			}

			thresholdBySession.set(sessionId, threshold);
			pi.appendEntry(THRESHOLD_STATE_ENTRY, { tokens: threshold });
			ctx.ui.notify(`Compaction threshold set to ${formatTokenCount(threshold)} tokens for this session.`, "info");
			if (ctx.isIdle()) scheduleThresholdCompaction(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sessionGeneration++;
		payloadShapeBySession.clear();
		thresholdBySession.clear();
		const threshold = readStoredThreshold(ctx.sessionManager.getBranch() as StoredThresholdEntry[]);
		if (threshold !== undefined) thresholdBySession.set(ctx.sessionManager.getSessionId(), threshold);
		scheduledSessions.clear();
		transaction = undefined;
		clearStatus(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		sessionGeneration++;
		payloadShapeBySession.clear();
		thresholdBySession.clear();
		scheduledSessions.clear();
		transaction = undefined;
		clearStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		payloadShapeBySession.delete(ctx.sessionManager.getSessionId());
	});

	pi.on("context", (event, ctx) => {
		const checkpoint = findNativeCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (checkpoint.status === "none") return undefined;
		return { messages: event.messages.filter((message) => message.role !== "compactionSummary") };
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return;
		setFeatureHeader(event.headers);
		if (ctx.model.id === "gpt-6-astra") {
			setHeaderIfMissing(event.headers, "version", CODEX_CLIENT_VERSION);
		}
	});

	pi.on("turn_end", (event, ctx) => {
		if (event.message.stopReason !== "toolUse" || ctx.signal?.aborted) return;
		if (event.toolResults.length === 0 || event.toolResults.every((result) => result.terminate)) return;
		scheduleThresholdCompaction(ctx, true);
	});

	pi.on("agent_settled", (_event, ctx) => {
		scheduleThresholdCompaction(ctx);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx.model;
		if (!isOpenAICodexModel(model) || !isJsonObject(event.payload)) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		payloadShapeBySession.set(sessionId, { modelKey: modelKey(model), payload: stripInputFromPayload(event.payload) });

		try {
			const branch = ctx.sessionManager.getBranch() as SessionEntry[];
			if (findNativeCheckpoint(branch).status === "none") return undefined;
			const input = effectiveInputForBranch({ branch, model, tools: pi.getAllTools(), sessionId, compression: compressionMode(ctx) });
			const payload: JsonObject = { ...event.payload, input };
			delete payload.messages;
			delete payload.previous_response_id;
			return payload;
		} catch (error) {
			ctx.abort();
			if (ctx.hasUI) ctx.ui.notify(`OpenAI Codex request blocked: ${errorMessage(error)}`, "error");
			const payload: JsonObject = { ...event.payload, input: [] };
			delete payload.messages;
			delete payload.previous_response_id;
			return payload;
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		const sessionId = ctx.sessionManager.getSessionId();
		const threshold = thresholdBySession.get(sessionId);
		const usageTokens = ctx.getContextUsage()?.tokens;
		const contextTokens = usageTokens ?? event.preparation.tokensBefore;
		if (event.reason === "threshold" && threshold !== undefined && contextTokens < threshold) {
			return { cancel: true };
		}
		if (!isOpenAICodexModel(model)) return undefined;
		const branch = event.branchEntries as SessionEntry[];
		const sourceLeafId = branch.at(-1)?.id;
		if (!sourceLeafId) return { cancel: true };

		let state: CompactionTransaction;
		try {
			state = beginTransaction(ctx, event.reason, sourceLeafId);
			const sessionId = state.sessionId;
			const input = effectiveInputForBranch({
				branch,
				compression: compressionMode(ctx),
				model,
				tools: pi.getAllTools(),
				sessionId,
				excludeLastAssistantError: event.reason === "overflow" && event.willRetry,
			});
			const cached = payloadShapeBySession.get(sessionId);
			const native = await createNativeCheckpoint({
				ctx,
				model,
				input,
				transaction: state,
				basePayload: cached?.modelKey === modelKey(model) ? cached.payload : undefined,
				signal: event.signal,
			});
			if (transaction !== state) throw new Error("Codex compaction transaction was replaced before completion.");
			if (ctx.sessionManager.getLeafId() !== sourceLeafId) {
				throw new Error("Session changed while Codex compaction was running.");
			}
			state.phase = "prepared";
			stopProgressTimer();
			return {
				compaction: {
					summary: localMarker(),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: native.usage,
					details: native.details,
				},
			};
		} catch (error) {
			const message = errorMessage(error);
			if (transaction) transaction.failureMessage = message;
			if (!event.signal.aborted && ctx.hasUI) {
				ctx.ui.notify(`OpenAI Codex native compaction failed: ${message}`, "error");
			}
			return { cancel: true };
		}
	});

	pi.on("session_compact", (event, ctx) => {
		scheduledSessions.delete(ctx.sessionManager.getSessionId());
		const state = transaction;
		if (!state || state.sessionId !== ctx.sessionManager.getSessionId()) return;
		const details = event.compactionEntry.details;
		if (
			state.phase !== "prepared"
			|| event.compactionEntry.parentId !== state.sourceLeafId
			|| !isJsonObject(details)
			|| details.kind !== NATIVE_COMPACTION_KIND
			|| details.checkpointId !== state.checkpointId
		) {
			finishFailed(ctx, state, "Committed Codex checkpoint did not match its source transaction.");
			return;
		}
		transaction = undefined;
		clearStatus(ctx);
		pi.events.emit(CODEX_COMPACTION_COMMITTED_EVENT, {
			transactionId: state.transactionId,
			checkpointId: state.checkpointId,
			sessionId: state.sessionId,
			reason: state.reason,
			sourceLeafId: state.sourceLeafId,
			compactionEntryId: event.compactionEntry.id,
		} satisfies CodexCompactionCommitted);
	});

	pi.on("session_compact_failed", (event, ctx) => {
		scheduledSessions.delete(ctx.sessionManager.getSessionId());
		const state = transaction;
		if (!state || state.sessionId !== ctx.sessionManager.getSessionId()) return;
		finishFailed(ctx, state, state.failureMessage ?? event.errorMessage ?? (event.aborted ? "Compaction was aborted." : undefined));
	});
}
