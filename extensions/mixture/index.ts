import { readFileSync } from "node:fs";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isSwarmAttached } from "../agent-swarm/events.ts";
import { queryBackgroundJobs } from "../bg-bash/events.ts";
import { CHECKPOINT, CHECKPOINT_BLOB, checkpointBlobs, encodeCheckpoint, encodeMarker, MAX_DELTA_CHAIN, restoreCheckpoint, type CheckpointStage } from "./checkpoint.ts";
import { configPath, loadConfig, saveConfig, type MixtureConfig } from "./config.ts";
import { cloneJson } from "./delta.ts";
import { releaseProviderSessions } from "./events.ts";
import { addUsage, callRole, createMixtureProvider, emitMessage, emptyUsage, failureMessage, resolveModel, type Registry, type RoleStreamOptions } from "./provider.ts";
import { CONTROL, ControlParams, MixtureSession, controlTool, newState } from "./session.ts";
import { compactStatus, configure, controlCall, controlCard, inspection, Inspector } from "./ui.ts";
import { receiptIds, tagReceipts } from "./usage.ts";

export async function createMixtureExtension(pi: ExtensionAPI, initialRegistry?: Registry) {
	let registry = initialRegistry ?? new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false }));
	let config: MixtureConfig | undefined;
	let diagnostic: string | undefined;
	let registered: Provider | undefined;
	let ctx: ExtensionContext | undefined;
	let session: MixtureSession | undefined;
	let rootId: string | undefined;
	let persistedState: MixtureSession["state"] | undefined;
	let persistedStage: CheckpointStage | undefined;
	let persistedHash: string | undefined;
	let stateGeneration = 0;
	let persistedGeneration = -1;
	let deltaChain = 0;
	let persistedBlobs = new Set<string>();
	let pending: Promise<AssistantMessage> | undefined;
	let requesting = false;
	let compacting = false;
	try { config = loadConfig(); }
	catch (error) { diagnostic = String(error); }
	const selected = () => ctx?.model?.provider === "mixture" && !!config?.presets[ctx.model.id];
	const status = () => diagnostic ?? (session ? inspection(session) : `Mixture presets: ${Object.keys(config!.presets).join(", ")}. Select mixture/<preset> with /model. Config: ${configPath()}`);
	const render = () => { if (ctx?.hasUI) ctx.ui.setStatus("mixture", selected() ? session ? compactStatus(session, compacting) : "lead · unavailable · $?" : undefined); };
	const releaseRoleResources = (target = session) => {
		if (!target || !rootId) return;
		releaseProviderSessions(pi, target.resourceSessionIds(rootId));
	};
	const persist = (stage: CheckpointStage) => {
		if (!ctx || !session || ctx.sessionManager.getSessionId() !== rootId) return;
		const checkpointStage = requesting ? "request" : stage;
		if (persistedHash && stateGeneration === persistedGeneration) {
			if (checkpointStage === persistedStage) return;
			pi.appendEntry(CHECKPOINT, encodeMarker(ctx.cwd, checkpointStage, persistedHash));
			persistedStage = checkpointStage;
			return;
		}
		const state = cloneJson(session.state);
		for (const blob of checkpointBlobs(state)) if (!persistedBlobs.has(blob.hash)) {
			pi.appendEntry(CHECKPOINT_BLOB, blob);
			persistedBlobs.add(blob.hash);
		}
		const checkpoint = encodeCheckpoint(ctx.cwd, checkpointStage, state, deltaChain < MAX_DELTA_CHAIN ? persistedState : undefined);
		pi.appendEntry(CHECKPOINT, checkpoint);
		persistedState = state;
		persistedStage = checkpointStage;
		persistedHash = checkpoint.hash;
		persistedGeneration = stateGeneration;
		deltaChain = checkpoint.kind === "delta" ? deltaChain + 1 : 0;
	};
	const detach = async (reason: string, warn = false) => {
		const old = session;
		if (!old) return;
		await old.abort();
		await pending?.catch(() => {});
		releaseRoleResources(old);
		old.reconcile(reason);
		persist("detached");
		if (warn && ctx) {
			const jobs = queryBackgroundJobs(pi, rootId!);
			const running = jobs.jobs.filter(job => job.status === "running");
			if (running.length || jobs.error) ctx.ui.notify(`Mixture stopped inference, not shell jobs. ${jobs.error ?? `Still running: ${running.map(job => job.id).join(", ")}`}`, "warning");
		}
		if (session === old) session = undefined;
		persistedState = undefined;
		persistedStage = undefined;
		persistedHash = undefined;
		persistedGeneration = -1;
		deltaChain = 0;
		persistedBlobs = new Set();
	};
	const activate = async (context: ExtensionContext, reset = false) => {
		if (session && (reset || context.sessionManager.getSessionId() !== rootId || context.model?.provider !== "mixture" || session.state.preset !== context.model.id)) await detach("model or session changed", true);
		ctx = context;
		registry = context.modelRegistry;
		const active = pi.getActiveTools().filter(name => name !== CONTROL);
		pi.setActiveTools(selected() ? [...active, CONTROL] : active);
		if (selected() && !isSwarmAttached(pi)) ensureSession();
		render();
	};
	const inheritFastMode = (options?: SimpleStreamOptions): RoleStreamOptions | undefined => {
		const fast: { enabled?: boolean } = {};
		pi.events.emit("fast:query", fast);
		if (fast.enabled === undefined) return options;
		return { ...options, serviceTier: fast.enabled ? "priority" : "default" };
	};
	const ensureSession = () => {
		if (!selected() || !ctx || !config) throw new Error("Select a Mixture model first");
		if (isSwarmAttached(pi)) throw new Error("Mixture cannot execute while a managed swarm is attached. Stop or finish that swarm first.");
		if (!session) {
			const name = ctx.model!.id;
			const preset = config.presets[name];
			const branch = ctx.sessionManager.getBranch();
			persistedBlobs = new Set(branch.flatMap(entry => entry.type === "custom" && entry.customType === CHECKPOINT_BLOB && typeof (entry.data as any)?.hash === "string" ? [(entry.data as any).hash] : []));
			const restored = restoreCheckpoint(branch, ctx.sessionManager.getEntries(), name, preset, ctx.cwd);
			const rootCompaction = branch.findLast(entry => entry.type === "compaction");
			rootId = ctx.sessionManager.getSessionId();
			const owner = rootId;
			const created = new MixtureSession(preset, registry, restored.state ?? newState(name, preset), () => queryBackgroundJobs(pi, owner), () => {
				if (session !== created || ctx?.sessionManager.getSessionId() !== owner) return;
				stateGeneration++;
				render(); persist("response");
			}, ctx.cwd);
			session = created;
			if (rootCompaction && created.state.rootCompactionId !== rootCompaction.id) {
				if (restored.state) created.rebaseLeadAfterCompaction(rootCompaction.id);
				else created.state.rootCompactionId = rootCompaction.id;
			}
			if (restored.state) created.reconcile("session restored");
			if (restored.warning) { created.state.warning = restored.warning; ctx.ui.notify(restored.warning, "warning"); }
		}
		return session;
	};
	const buildProvider = (candidate: MixtureConfig) => createMixtureProvider(candidate, registry.find.bind(registry), (name, context, options) => {
		const stream = createAssistantMessageEventStream();
		const preset = candidate.presets[name];
		void (async () => {
			try {
				const inheritedOptions = inheritFastMode(options);
				if (selected() && ctx?.model?.id === name && options?.sessionId === ctx.sessionManager.getSessionId()) {
					const active = ensureSession();
					requesting = true; render(); persist("request");
					const request = active.next(context, inheritedOptions, ctx.thinkingLevel);
					pending = request;
					const message = await request;
					if (pending === request) { pending = undefined; requesting = false; }
					if (session === active) persist("response");
					const outward = ["error", "aborted"].includes(message.stopReason) ? message : { ...message, usage: { ...emptyUsage(), totalTokens: active.rootContextTokens() } };
					emitMessage(stream, outward);
					return;
				}
				// Pi helper requests have a separate routing ID and never join a run.
				const model = resolveModel(preset.lead, registry.find.bind(registry));
				emitMessage(stream, await callRole(registry, preset.lead, context, inheritedOptions?.reasoning ?? (model.reasoning ? ctx?.thinkingLevel ?? "high" : "off"), {
					...inheritedOptions, timeoutMs: preset.limits.requestTimeoutMs,
					maxTokens: Math.min(inheritedOptions?.maxTokens ?? preset.limits.leadMaxTokens, preset.limits.leadMaxTokens),
				}));
			} catch (error) {
				if (options?.sessionId === rootId) { pending = undefined; requesting = false; }
				emitMessage(stream, failureMessage({ api: "mixture", provider: "mixture", id: name } as Model<any>, error, options?.signal?.aborted));
			}
		})();
		return stream;
	});
	pi.registerTool({
		name: CONTROL, label: "Mixture", description: controlTool.description, parameters: ControlParams,
		execute: async (id, input, signal, _update, context) => {
			if (signal?.aborted) throw new Error("Mixture control cancelled");
			ctx = context;
			const active = ensureSession();
			return active.control(id, input);
		},
		renderCall: (args, theme, context) => controlCall(args, context.expanded, theme),
		renderResult: (result, options, theme) => controlCard(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"), options.expanded, theme),
	});
	pi.registerCommand("mixture", {
		description: "Configure or inspect Mixture models",
		getArgumentCompletions: prefix => ["status", "configure", "inspect"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
		handler: async (args, context) => {
			const [action = "status", name, extra] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (extra || !["status", "configure", "inspect"].includes(action) || name && action !== "configure") throw new Error("Usage: /mixture [status | inspect | configure [preset]]");
				if (action !== "configure") {
					if (selected()) ensureSession();
					if (action === "inspect" && context.mode === "tui") await context.ui.custom<void>((tui, theme, _keys, done) => new Inspector(status(), () => Math.min(30, tui.terminal.rows - 4), () => tui.requestRender(), () => done(), theme), { overlay: true, overlayOptions: { width: "100%", maxHeight: "90%" } });
					else context.ui.notify(status(), diagnostic ? "error" : "info");
					return;
				}
				if (session) {
					const jobs = queryBackgroundJobs(pi, rootId!);
					if (jobs.error || jobs.jobs.some(job => job.status === "running") || session.state.bgManaged && !jobs.available) throw new Error("Reconcile Mixture's background jobs before changing its configuration");
				}
				let before: string | null = null;
				try { before = readFileSync(configPath(), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
				const proposed = await configure(context, config, name);
				if (!proposed) return;
				if (context.model?.provider === "mixture" && !Object.hasOwn(proposed.presets, context.model.id)) throw new Error("Select another model before removing the active Mixture preset");
				const provider = buildProvider(proposed);
				pi.registerProvider(provider);
				try { saveConfig(proposed, undefined, before); }
				catch (error) { if (registered) pi.registerProvider(registered); else pi.unregisterProvider("mixture"); throw error; }
				await detach("configuration changed");
				config = proposed; registered = provider; diagnostic = undefined;
				if (context.model?.provider === "mixture") {
					const replacement = context.modelRegistry.find("mixture", context.model.id);
					if (replacement) await pi.setModel(replacement);
				}
				context.ui.notify(`Saved ${configPath()}. Select mixture/<preset> with /model.`, "info");
			} catch (error) { context.ui.notify(String(error), "error"); }
		},
	});
	pi.on("session_start", async (_event, context) => { await activate(context, true); if (diagnostic) context.ui.notify(diagnostic, "error"); });
	pi.on("model_select", (_event, context) => activate(context));
	pi.on("before_agent_start", async (event, context) => { await activate(context); if (selected()) ensureSession().newRequest(event.prompt); });
	pi.on("agent_start", () => { if (selected()) session?.resumeLoop(); });
	pi.on("tool_call", event => {
		if (!selected()) return;
		try { ensureSession().guard(event.toolCallId, event.toolName, event.input); }
		catch (error) { return { block: true, reason: String(error) }; }
	});
	pi.on("tool_result", (event, context) => {
		if (!session || context.sessionManager.getSessionId() !== rootId) return;
		const nested = session.takeUsage();
		if (!nested.totalTokens && !nested.cost.total) return;
		const usage = structuredClone(event.usage ?? emptyUsage());
		addUsage(usage, nested);
		const details = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details : {};
		return { usage, details: { ...details, mixtureReceiptIds: [...new Set([...receiptIds(details), ...session.lastDrained])] } };
	});
	pi.on("message_end", async event => {
		if (!selected() || !session || event.message.role !== "assistant" || !["aborted", "error"].includes(event.message.stopReason)) return;
		const usage = await session.drainAfterAbort();
		if (!usage.totalTokens && !usage.cost.total) return;
		addUsage(usage, event.message.usage);
		return { message: tagReceipts({ ...event.message, usage }, session.lastDrained) };
	});
	pi.on("turn_end", event => { if (selected()) { session?.completeTurn(event.toolResults, event.message.role === "assistant" ? event.message : undefined); persist("turn"); } });
	pi.on("agent_end", async () => { if (session) { await session.abort(); releaseRoleResources(); session.reconcile("request ended"); persist("idle"); } render(); });
	pi.on("session_before_switch", () => detach("session switch"));
	pi.on("session_before_fork", () => detach("session fork"));
	pi.on("session_before_tree", () => detach("tree navigation"));
	pi.on("session_tree", (_event, context) => activate(context, true));
	pi.on("session_before_compact", () => { compacting = true; render(); return detach("compaction"); });
	pi.on("session_compact", (_event, context) => { compacting = false; return activate(context, true); });
	pi.on("session_compact_failed", (_event, context) => { compacting = false; return activate(context, true); });
	pi.on("session_shutdown", async () => { await detach("session shutdown", true); ctx = undefined; rootId = undefined; });
	if (config) {
		try { registered = buildProvider(config); pi.registerProvider(registered); }
		catch (error) { diagnostic = `Mixture registration failed: ${String(error)}`; }
	}
}

export default createMixtureExtension;
