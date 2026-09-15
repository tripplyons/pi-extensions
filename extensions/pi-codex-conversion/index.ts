import { readFileSync } from "node:fs";
import codexConversion from "@howaboua/pi-codex-conversion";
import { closeOpenAICodexWebSocketSessions } from "@howaboua/pi-codex-conversion/dist/providers/openai-codex-custom-provider.js";
import { getCodexConversionConfigPath, getProjectCodexConversionConfigPath } from "@howaboua/pi-codex-conversion/dist/adapter/activation/config-store.js";
import { stripAdapterTools } from "@howaboua/pi-codex-conversion/dist/adapter/activation/activation.js";
import { ALL_CODEX_ADAPTER_TOOL_NAMES } from "@howaboua/pi-codex-conversion/dist/adapter/activation/runtime-plan.js";
import { convertToLlm, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTEXT_WINDOW_MIN_RESERVE } from "@howaboua/pi-codex-conversion/src/context-management/messages.ts";
import { isMixtureSessionRelease, MIXTURE_SESSION_RELEASE_EVENT } from "../mixture/events.ts";
import { appendActiveMessage, commitContextTransition, createLocalContext, reconcileLocalContext, scheduleContextTransition, type LocalContextState } from "./local-context.ts";
import { createLocalContextTools, LOCAL_CONTEXT_QUERY_EVENT, LOCAL_CONTEXT_TOOLS, type LocalContextQuery, type LocalContextTarget } from "./local-context-tools.ts";
import { preserveLocalCodexProvider, releaseLocalCodexLanes, sanitizeNativeCodexPayload } from "./local-codex-provider.ts";
import { restoreStandaloneContext, snapshotStandaloneContext } from "./standalone-context.ts";

export const LOCAL_CONTEXT_ENTRY = "pi-codex-local-context-v1";

export function localContextDiagnostics(state: LocalContextState | undefined, activeCodexRequests: number) {
	return {
		codexTransport: "sse", activeCodexRequests,
		...(state ? {
			role: state.identity.role, preset: state.identity.preset, windowId: state.activeWindowId,
			activeItems: state.activeItems.length, archivedWindows: state.archives.length,
			noteFiles: state.notes.length, noteBytes: state.notes.reduce((bytes, note) => bytes + Buffer.byteLength(note.text, "utf8"), 0),
			transitionPending: !!state.pending,
		} : { localContext: "unavailable" }),
	};
}

export function localPolicyViolations(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const config = value as Record<string, any>;
	const compaction = config.compaction && typeof config.compaction === "object" ? config.compaction : {};
	const openai = config.openai && typeof config.openai === "object" ? config.openai : {};
	return [
		compaction.contextManagement && compaction.contextManagement !== "off" ? `compaction.contextManagement=${compaction.contextManagement}` : undefined,
		compaction.hybridCompaction === true ? "compaction.hybridCompaction=true" : undefined,
		compaction.responsesCompaction === true ? "compaction.responsesCompaction=true" : undefined,
		compaction.portableSummary === true ? "compaction.portableSummary=true" : undefined,
		openai.proxyResponsesLite === true ? "openai.proxyResponsesLite=true" : undefined,
		openai.forceCachedWebSockets === true ? "openai.forceCachedWebSockets=true" : undefined,
		openai.cacheKeepalive === true ? "openai.cacheKeepalive=true" : undefined,
		typeof openai.lunaCacheKeepaliveMinutes === "number" && openai.lunaCacheKeepaliveMinutes > 0 ? `openai.lunaCacheKeepaliveMinutes=${openai.lunaCacheKeepaliveMinutes}` : undefined,
		openai.cacheDiagnostics && openai.cacheDiagnostics !== "off" ? `openai.cacheDiagnostics=${openai.cacheDiagnostics}` : undefined,
	].filter((value): value is string => !!value);
}

function readConfigDocument(path: string): unknown {
	try { return JSON.parse(readFileSync(path, "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Cannot read local Codex policy configuration: ${path}`, { cause: error });
	}
}

export function closeMixtureCodexSessions(value: unknown, close = closeOpenAICodexWebSocketSessions) {
	if (!isMixtureSessionRelease(value)) return;
	releaseLocalCodexLanes(value.sessionIds);
	for (const id of value.sessionIds) close(id);
}

const CONFLICTING_UPSTREAM_CONTEXT_HOOKS = new Set([
	"context",
	"session_before_switch",
	"session_before_fork",
	"session_before_tree",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
]);
const ISOLATED_UPSTREAM_CONTEXT_EVENTS = new Set([
	"input",
	"session_start",
	"model_select",
	"session_tree",
	"before_agent_start",
	"agent_start",
	"agent_settled",
	"turn_end",
	"before_provider_request",
	"before_provider_headers",
]);

function upstreamContextWithoutModel(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	return new Proxy(value, { get(target, property, receiver) { return property === "model" ? undefined : Reflect.get(target, property, receiver); } });
}

/**
 * The upstream extension owns a second context lifecycle. Do not register its
 * projection, rollover, or remote-compaction hooks; the wrapper registers the
 * local equivalents below. Other upstream hooks, including voice hooks, stay
 * registered. The provider-request hook is retained and only its known native
 * remote additions are removed before later callbacks reach the final guard.
 */
export function suppressUpstreamLocalContextHooks(pi: ExtensionAPI): ExtensionAPI {
	let insideUpstreamHandler = false;
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") return (tool: { name?: string }) => {
				if (tool.name && LOCAL_CONTEXT_TOOLS.includes(tool.name as typeof LOCAL_CONTEXT_TOOLS[number])) return;
				return target.registerTool(tool as never);
			};
			if (property === "setActiveTools") return (...args: any[]) => {
				if (!insideUpstreamHandler) return (target.setActiveTools as any)(...args);
				const local = target.getActiveTools().filter(name => LOCAL_CONTEXT_TOOLS.includes(name as typeof LOCAL_CONTEXT_TOOLS[number]));
				const ordinary = stripAdapterTools(Array.isArray(args[0]) ? args[0] : [], ALL_CODEX_ADAPTER_TOOL_NAMES);
				return target.setActiveTools([...new Set([...ordinary, ...local])]);
			};
			if (property === "sendUserMessage") return (...args: any[]) => insideUpstreamHandler ? undefined : (target.sendUserMessage as any)(...args);
			if (property !== "on") return Reflect.get(target, property, receiver);
			return ((event: string, handler: (...args: any[]) => unknown) => {
				if (CONFLICTING_UPSTREAM_CONTEXT_HOOKS.has(event)) return;
				return target.on(event as never, (incoming: { payload?: unknown }, context: unknown) => {
					const isolated = ISOLATED_UPSTREAM_CONTEXT_EVENTS.has(event);
					const previous = insideUpstreamHandler;
					insideUpstreamHandler ||= isolated;
					let result: unknown;
					try { result = handler(incoming, isolated ? upstreamContextWithoutModel(context) : context); }
					catch (error) { insideUpstreamHandler = previous; throw error; }
					const finish = (value: unknown) => {
						insideUpstreamHandler = previous;
						return event === "before_provider_request" ? sanitizeNativeCodexPayload(incoming.payload, value) : value;
					};
				if (!result || typeof (result as PromiseLike<unknown>).then !== "function") return finish(result);
				return (result as PromiseLike<unknown>).then(finish, error => { insideUpstreamHandler = previous; throw error; });
				}) as never;
			}) as ExtensionAPI["on"];
		},
	});
}

export function preserveNativeFollowUpShortcut(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property !== "registerShortcut") return Reflect.get(target, property, receiver);
			return (
				key: Parameters<ExtensionAPI["registerShortcut"]>[0],
				options: Parameters<ExtensionAPI["registerShortcut"]>[1],
			) => {
				if (key.toLowerCase() === "alt+enter") return;
				return target.registerShortcut(key, options);
			};
		},
	});
}

function isStandaloneCodex(ctx: ExtensionContext | undefined) {
	return ctx?.model?.provider === "openai-codex" || ctx?.model?.api === "openai-codex-responses";
}

function contextMessages(ctx: ExtensionContext) {
	return convertToLlm(ctx.sessionManager.buildSessionContext().messages);
}

export default async function piCodexConversion(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	let state: LocalContextState | undefined;
	let stateSessionId: string | undefined;
	let restoreFailure: string | undefined;
	const ownedLanes = new Set<() => void>();
	const releaseOwnedLanes = () => { for (const cancel of [...ownedLanes]) cancel(); };
	const acquireLane = (_id: string, cancel: () => void) => {
		ownedLanes.add(cancel);
		return () => { ownedLanes.delete(cancel); };
	};
	const assertCompatiblePolicy = () => {
		if (restoreFailure && isStandaloneCodex(ctx)) throw new Error(restoreFailure);
		const paths = [getCodexConversionConfigPath(), ...(ctx?.isProjectTrusted() ? [getProjectCodexConversionConfigPath(ctx.cwd)] : [])];
		const violations = [...new Set(paths.flatMap(path => localPolicyViolations(readConfigDocument(path))))];
		if (violations.length) throw new Error(`Local Codex request refused incompatible settings: ${violations.join(", ")}. Disable these settings in pi-codex-conversion.json; configuration was not changed.`);
	};
	const persist = (pendingMessage = false) => {
		if (ctx && state && isStandaloneCodex(ctx) && ctx.sessionManager.getSessionId() === stateSessionId) pi.appendEntry(LOCAL_CONTEXT_ENTRY, snapshotStandaloneContext(state, ctx.sessionManager.getBranch(), pendingMessage));
	};
	const target = (): LocalContextTarget | undefined => {
		if (!state || !ctx || !isStandaloneCodex(ctx)) return undefined;
		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : ctx.model?.contextWindow ?? 0;
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
		const reserveTokens = Math.max(CONTEXT_WINDOW_MIN_RESERVE, settings.getCompactionSettings().reserveTokens);
		return {
			state,
			contextWindow,
			reserveTokens,
			usedTokens: usage?.tokens ?? undefined,
			changed: persist,
		};
	};
	pi.events.on(MIXTURE_SESSION_RELEASE_EVENT, closeMixtureCodexSessions);
	await codexConversion(suppressUpstreamLocalContextHooks(preserveLocalCodexProvider(preserveNativeFollowUpShortcut(pi), assertCompatiblePolicy, acquireLane)));
	for (const tool of createLocalContextTools(pi, target)) pi.registerTool(tool);
	pi.registerCommand("codex-local", {
		description: "Inspect local context counts and active Codex requests without prompt or note contents",
		handler: async (_args, context) => {
			const query: LocalContextQuery = { sessionId: context.sessionManager.getSessionId() };
			pi.events.emit(LOCAL_CONTEXT_QUERY_EVENT, query);
			const current = query.target?.state ?? (isStandaloneCodex(context) ? state : undefined);
			context.ui.notify(JSON.stringify(localContextDiagnostics(current, ownedLanes.size), null, 2), "info");
		},
	});
	const syncLocalToolActivation = (context: ExtensionContext) => {
		const current = new Set(pi.getActiveTools());
		for (const name of LOCAL_CONTEXT_TOOLS) isStandaloneCodex(context) || context.model?.provider === "mixture" ? current.add(name) : current.delete(name);
		pi.setActiveTools([...current]);
	};
	const activate = (context: ExtensionContext) => {
		releaseOwnedLanes();
		ctx = context;
		restoreFailure = undefined;
		syncLocalToolActivation(context);
		if (!isStandaloneCodex(context)) {
			state = undefined;
			stateSessionId = undefined;
			return;
		}
		const identity = { branchId: context.sessionManager.getSessionId(), preset: "standalone-codex", role: "/root" };
		stateSessionId = identity.branchId;
		const branch = context.sessionManager.getBranch();
		const storedIndex = branch.findLastIndex(entry => entry.type === "custom" && entry.customType === LOCAL_CONTEXT_ENTRY);
		const stored = branch[storedIndex];
		try {
			const candidate = stored?.type === "custom" ? restoreStandaloneContext(stored.data, branch, storedIndex, contextMessages(context)) : undefined;
			if (candidate) {
				if (candidate.identity.preset !== identity.preset || candidate.identity.role !== identity.role) throw new Error("Stored local context actor/preset identity does not match standalone Codex");
				candidate.identity.branchId = identity.branchId;
				state = candidate;
			} else {
				state = createLocalContext(identity, contextMessages(context));
				reconcileLocalContext(state, contextMessages(context).findLast(message => message.role === "user"));
			}
		} catch (error) {
			state = undefined;
			restoreFailure = `Local Codex context restore failed; requests are disabled and the stored entry was not changed: ${String(error)}`;
			context.ui.notify(restoreFailure, "error");
		}
	};
	pi.on("session_start", (_event, context) => activate(context));
	pi.on("model_select", (_event, context) => activate(context));
	pi.on("before_agent_start", (_event, context) => { ctx = context; });
	pi.on("message_end", (event, context) => {
		if (!state || !isStandaloneCodex(context)) return;
		ctx = context;
		const messages = convertToLlm([event.message]);
		for (const message of messages) appendActiveMessage(state, message);
		if (messages.length) persist(true);
	});
	pi.on("context", (_event, context) => state && isStandaloneCodex(context) ? { messages: structuredClone(state.activeMessages) } : undefined);
	pi.on("agent_settled", (_event, context) => syncLocalToolActivation(context));
	pi.on("turn_end", (event, context) => {
		if (!state || !isStandaloneCodex(context) || event.message.role !== "assistant") return;
		if (state.pending) reconcileLocalContext(state, contextMessages(context).findLast(message => message.role === "user"));
		persist();
	});
	pi.on("session_before_compact", (_event, context) => {
		releaseOwnedLanes();
		if (state && isStandaloneCodex(context)) persist();
	});
	pi.on("session_compact", (event, context) => {
		if (!state || !isStandaloneCodex(context)) return;
		scheduleContextTransition(state);
		commitContextTransition(state, { summary: event.compactionEntry.summary, boundaryGroup: contextMessages(context) });
		persist();
	});
	pi.on("session_compact_failed", (_event, context) => {
		if (state && isStandaloneCodex(context)) persist();
	});
	const detach = () => { releaseOwnedLanes(); persist(); };
	pi.on("agent_end", (_event, context) => {
		releaseOwnedLanes();
		if (state && isStandaloneCodex(context)) {
			reconcileLocalContext(state, contextMessages(context).findLast(message => message.role === "user"));
			persist();
		}
	});
	pi.on("session_before_switch", detach);
	pi.on("session_before_fork", detach);
	pi.on("session_before_tree", detach);
	pi.on("session_tree", (_event, context) => activate(context));
	pi.on("session_shutdown", detach);
}
