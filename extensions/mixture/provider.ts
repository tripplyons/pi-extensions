import { createHash } from "node:crypto";
import {
	createAssistantMessageEventStream, getSupportedThinkingLevels,
	type Api, type AssistantMessage, type AssistantMessageEventStream, type Context,
	type Model, type ModelThinkingLevel, type Provider, type SimpleStreamOptions, type Usage,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { splitModel, type MixtureConfig, type Preset, type RoleConfig } from "./config.ts";
import { systemScheduler, type ScheduledTask, type Scheduler } from "../scheduler.ts";

export type Registry = Pick<ModelRegistry, "find" | "getProvider" | "getApiKeyAndHeaders">;
export type Lookup = (provider: string, model: string) => Model<Api> | undefined;
export type MixtureStream = (preset: string, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
export type RoleStreamOptions = SimpleStreamOptions & { serviceTier?: "priority" | "default" };
export const applyRoleFastMode = (role: Pick<RoleConfig, "fast"> | undefined, options?: RoleStreamOptions): RoleStreamOptions | undefined =>
	role?.fast === undefined ? options : { ...options, serviceTier: role.fast ? "priority" : "default" };
export type RequestLane = "ordinary" | "summary" | "overflow" | "helper";
export function requestLaneId(root: string, run: string, role: string, lane: RequestLane): string {
	return `mixture-lane/${createHash("sha256").update(JSON.stringify([root, run, role, lane])).digest("hex")}`;
}
export const emptyUsage = (): Usage => ({
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
export function addUsage(target: Usage, source: Usage) {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += source[key];
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += source.cost[key];
	if (source.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + source.reasoning;
	if (source.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h ?? 0) + source.cacheWrite1h;
}
export function resolveModel(id: string, find: Lookup): Model<Api> {
	const [provider, model] = splitModel(id);
	const resolved = find(provider, model);
	if (!resolved) throw new Error(`Mixture model is unavailable: ${id}`);
	return resolved;
}
export function validatePreset(preset: Preset, find: Lookup) {
	const roles = preset.mode === "advisor" ? [preset.executor, preset.advisor] : [preset.writer, ...preset.reviewers];
	if (preset.mode === "handoff") resolveModel(preset.lead, find);
	for (const role of roles) {
		const resolved = resolveModel(role.model, find);
		if (!getSupportedThinkingLevels(resolved).includes(role.thinking)) {
			throw new Error(`${role.model} does not support thinking ${role.thinking}; supported: ${getSupportedThinkingLevels(resolved).join(", ")}`);
		}
	}
}
export function modelDefinition(name: string, preset: Preset, find: Lookup): Model<Api> {
	const ids = preset.mode === "advisor"
		? [preset.executor.model, preset.advisor.model]
		: [preset.lead, preset.writer.model, ...preset.reviewers.map(role => role.model)];
	const models = ids.map(id => resolveModel(id, find));
	const primary = models[0];
	const maxTokens = preset.mode === "advisor" ? preset.limits.executorMaxTokens : preset.limits.leadMaxTokens;
	return {
		id: name, name: `Mixture: ${name} (${preset.mode})`, api: "mixture", provider: "mixture", baseUrl: "",
		reasoning: primary.reasoning, thinkingLevelMap: primary.thinkingLevelMap,
		input: preset.mode === "advisor" ? primary.input : models.every(model => model.input.includes("image")) ? ["text", "image"] : ["text"],
		contextWindow: preset.mode === "advisor" ? primary.contextWindow : Math.min(...models.map(model => model.contextWindow)),
		maxTokens: Math.min(primary.maxTokens, maxTokens),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}
export function createMixtureProvider(config: MixtureConfig, find: Lookup, stream: MixtureStream): Provider {
	for (const preset of Object.values(config.presets)) validatePreset(preset, find);
	const models = Object.entries(config.presets).map(([name, preset]) => modelDefinition(name, preset, find));
	const dispatch = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		if (!Object.hasOwn(config.presets, model.id)) return failedStream(model, `Unknown Mixture preset: ${model.id}`);
		return stream(model.id, context, options);
	};
	return {
		id: "mixture", name: "Mixture",
		auth: { apiKey: { name: "Uses role providers", resolve: async () => ({ auth: {}, source: "Mixture role providers" }) } },
		getModels: () => models,
		stream: (model, context, options) => dispatch(model, context, options && {
			signal: options.signal, maxTokens: options.maxTokens, sessionId: options.sessionId,
			cacheRetention: options.cacheRetention, onPayload: options.onPayload, onResponse: options.onResponse,
		}),
		streamSimple: dispatch,
	};
}

export function failureMessage(model: Model<Api>, error: unknown, aborted = false): AssistantMessage {
	return { role: "assistant", content: [], provider: model.provider, model: model.id, api: model.api,
		usage: emptyUsage(), timestamp: Date.now(), stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error) };
}
export function failedStream(model: Model<Api>, error: unknown): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message = failureMessage(model, error);
	stream.push({ type: "error", reason: "error", error: message });
	stream.end();
	return stream;
}

// Buffer role output until its full tool batch has been validated. In particular,
// a candidate final answer must not reach the user before its review checkpoint.
export function emitMessage(stream: AssistantMessageEventStream, message: AssistantMessage) {
	const partial = { ...message, content: [] as AssistantMessage["content"], stopReason: "pending" as const };
	stream.push({ type: "start", partial });
	for (const [contentIndex, original] of message.content.entries()) {
		const block = structuredClone(original);
		partial.content.push(block);
		if (block.type === "text") {
			const content = block.text;
			block.text = "";
			stream.push({ type: "text_start", contentIndex, partial });
			block.text = content;
			stream.push({ type: "text_delta", contentIndex, delta: content, partial });
			stream.push({ type: "text_end", contentIndex, content, partial });
		} else if (block.type === "thinking") {
			const content = block.thinking;
			block.thinking = "";
			stream.push({ type: "thinking_start", contentIndex, partial });
			block.thinking = content;
			stream.push({ type: "thinking_delta", contentIndex, delta: content, partial });
			stream.push({ type: "thinking_end", contentIndex, content, partial });
		} else {
			const args = block.arguments;
			block.arguments = {};
			stream.push({ type: "toolcall_start", contentIndex, partial });
			block.arguments = args;
			stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial });
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
		}
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
	} else if (message.stopReason === "pending" || message.stopReason === "deferred") {
		stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: `Unsupported terminal state: ${message.stopReason}` } });
	} else stream.push({ type: "done", reason: message.stopReason, message });
	stream.end();
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
	return new Promise((resolve, reject) => {
		const abort = () => { cleanup(); reject(signal.reason ?? new Error("Aborted")); };
		const cleanup = () => signal.removeEventListener("abort", abort);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
	});
}

export async function callRole(registry: Registry, id: string, context: Context, thinking: ModelThinkingLevel,
	options: RoleStreamOptions & { timeoutMs: number; idleTimeoutMs?: number }, onPartial?: (message: AssistantMessage) => void,
	onAcquire?: (sessionId: string) => void, scheduler: Scheduler = systemScheduler): Promise<AssistantMessage> {
	const model = resolveModel(id, registry.find.bind(registry));
	if (!getSupportedThinkingLevels(model).includes(thinking)) throw new Error(`${id} does not support thinking ${thinking}`);
	const deadline = new AbortController();
	const deadlineTimer = scheduler.after(options.timeoutMs, () => deadline.abort(new Error(`${id}: provider timeout after ${options.timeoutMs}ms`)));
	const idle = options.idleTimeoutMs === undefined ? undefined : new AbortController();
	let idleTimer: ScheduledTask | undefined;
	const resetIdle = () => {
		if (!idle || options.idleTimeoutMs === undefined) return;
		if (idleTimer) scheduler.cancel(idleTimer);
		idleTimer = scheduler.after(options.idleTimeoutMs, () => idle.abort(new Error(`${id}: provider idle timeout after ${options.idleTimeoutMs}ms`)));
	};
	const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), deadline.signal, ...(idle ? [idle.signal] : [])]);
	let latest: AssistantMessage | undefined;
	resetIdle();
	try {
		signal.throwIfAborted();
		const provider = registry.getProvider(model.provider);
		if (!provider) throw new Error(`Mixture provider is unavailable: ${model.provider}`);
		const auth = await abortable(registry.getApiKeyAndHeaders(model), signal);
		if (auth.ok === false) throw new Error(auth.error);
		signal.throwIfAborted();
		// Never carry the composite provider's authentication, headers, environment,
		// or sampling overrides into a different provider.
		const request: RoleStreamOptions = {
			signal, apiKey: auth.apiKey, headers: auth.headers, env: auth.env,
			timeoutMs: options.timeoutMs, maxRetries: 0,
			maxTokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens),
			...(thinking === "off" ? {} : { reasoning: thinking }),
			...(model.provider === "openai-codex" && options.serviceTier ? { serviceTier: options.serviceTier } : {}),
			sessionId: options.sessionId, cacheRetention: options.cacheRetention,
			onPayload: options.onPayload, onResponse: options.onResponse,
		};
		if (request.sessionId) onAcquire?.(request.sessionId);
		const source = provider.streamSimple(auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model, context, request);
		const consume = async () => {
			let terminal: AssistantMessage | undefined;
			for await (const event of source) {
				if (signal.aborted) break;
				resetIdle();
				latest = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
				onPartial?.(latest);
				if (event.type === "done") terminal = event.message;
				if (event.type === "error") terminal = event.error;
			}
			if (!terminal || terminal.stopReason === "pending") throw new Error(`${id}: provider ended without a terminal result`);
			return terminal;
		};
		return await abortable(consume(), signal);
	} catch (error) {
		return { ...failureMessage(model, error, options.signal?.aborted), usage: latest?.usage ?? emptyUsage() };
	} finally {
		scheduler.cancel(deadlineTimer);
		if (idleTimer) scheduler.cancel(idleTimer);
	}
}
