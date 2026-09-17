import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { queryBackgroundJobs, type BackgroundJobQuery } from "../bg-bash/events.ts";
import { CHECKPOINT, CHECKPOINT_BLOB, checkpointBlobs, encodeCheckpoint, encodeMarker, MAX_DELTA_CHAIN, restoreCheckpoint, type CheckpointStage } from "./checkpoint.ts";
import { configPath, loadConfig, MIN_ADVISOR_INTERVAL_MS, saveConfig, type AdvisorPreset, type MixtureConfig } from "./config.ts";
import { cloneJson } from "./delta.ts";
import { releaseProviderSessions } from "./events.ts";
import { addUsage, callRole, createMixtureProvider, emitMessage, emptyUsage, failureMessage, requestLaneId, resolveModel, type Registry, type RoleStreamOptions } from "./provider.ts";
import { CONTROL, ControlParams, MixtureSession, controlTool, newState } from "./session.ts";
import { compactStatus, configure, controlCall, controlCard, inspection, Inspector } from "./ui.ts";
import { receiptIds, tagReceipts } from "./usage.ts";
import { LOCAL_CONTEXT_QUERY_EVENT, type LocalContextQuery } from "../pi-codex-conversion/local-context-tools.ts";
import { createLocalContext } from "../pi-codex-conversion/local-context.ts";
import { systemScheduler, type ScheduledTask, type Scheduler } from "../scheduler.ts";
import { ASK_ADVISOR, AdvisorParams, advisorCallCount, advisorCooldownMs, advisorGuidelines, advisorIntervalLabel, advisorTool, consultAdvisor, type AdvisorInput } from "./advisor.ts";

export const backgroundDetachWarning = (jobs: BackgroundJobQuery) => {
	const running = jobs.jobs.filter(job => job.status === "running");
	return running.length || jobs.error
		? `Mixture stopped inference, not shell jobs. ${jobs.error ?? `Still running: ${running.map(job => job.id).join(", ")}`}`
		: undefined;
};

export async function createMixtureExtension(pi: ExtensionAPI, initialRegistry?: Registry, dependencies: { scheduler?: Scheduler } = {}) {
	const scheduler = dependencies.scheduler ?? systemScheduler;
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
	const helpers = new Set<AbortController>();
	const directSessionIds = new Set<string>();
	const reservedAdvisorCalls = new Set<string>();
	let advisorReminderTimer: ScheduledTask | undefined;
	let advisorRun = 0;
	let lastAdvisorStartedAt: number | undefined;
	let advisorActive = false;
	let advisorReminderId: string | undefined;
	try { config = loadConfig(); }
	catch (error) { diagnostic = String(error); }
	const selected = () => ctx?.model?.provider === "mixture" && !!config?.presets[ctx.model.id];
	const selectedPreset = () => selected() ? config!.presets[ctx!.model!.id] : undefined;
	const selectedHandoff = () => selectedPreset()?.mode === "handoff";
	const selectedAdvisor = (): AdvisorPreset | undefined => {
		const preset = selectedPreset();
		return preset?.mode === "advisor" ? preset : undefined;
	};
	const stopAdvisorReminders = () => {
		if (advisorReminderTimer) scheduler.cancel(advisorReminderTimer);
		advisorReminderTimer = undefined;
		advisorRun++;
		advisorReminderId = undefined;
	};
	const startAdvisorReminders = (context: ExtensionContext, preset: AdvisorPreset) => {
		stopAdvisorReminders();
		const run = advisorRun;
		advisorReminderTimer = scheduler.after(preset.limits.advisorIntervalMs, () => {
			advisorReminderTimer = undefined;
			if (run !== advisorRun || !advisorActive || !selectedAdvisor() || context.isIdle()) return;
			if (context.hasPendingMessages() || reservedAdvisorCalls.size) { startAdvisorReminders(context, preset); return; }
			advisorReminderId = randomUUID();
			try {
				pi.sendMessage({
					customType: "mixture-advisor-reminder",
					content: `Advisor review due. Call ${ASK_ADVISOR} now with a concise draft or focused question before making more edits or finalizing. This is a rate-limited review point, not a request for another coding agent.`,
					display: true,
					details: { intervalMs: preset.limits.advisorIntervalMs, reminderId: advisorReminderId },
				}, { deliverAs: "steer" });
			} catch { startAdvisorReminders(context, preset); }
		});
	};
	const status = () => {
		if (diagnostic) return diagnostic;
		if (session) return inspection(session);
		const advisor = selectedAdvisor();
		if (advisor && ctx) return [
			`Mixture ${ctx.model!.id} (advisor)`,
			`Executor: ${advisor.executor.model} (${advisor.executor.thinking})`,
			`Advisor: ${advisor.advisor.model} (${advisor.advisor.thinking})`,
			`Calls: ${advisorCallCount(ctx.sessionManager.getBranch())}`,
			`Advice: every ${advisorIntervalLabel(advisor.limits.advisorIntervalMs)}; minimum ${advisorIntervalLabel(MIN_ADVISOR_INTERVAL_MS)}`,
			`Context: ${advisor.context.maxChars} chars; Git ${advisor.context.git}; redaction ${advisor.context.redactSecrets ? "on" : "off"}`,
			`Gates: plan ${advisor.gates.plan ? "on" : "off"}; failure ${advisor.gates.failure ? "on" : "off"}; completion ${advisor.gates.completion ? "on" : "off"}`,
		].join("\n");
		return `Mixture presets: ${Object.entries(config!.presets).map(([name, preset]) => `${name} (${preset.mode})`).join(", ")}. Select mixture/<preset> with /model. Config: ${configPath()}`;
	};
	const render = () => {
		if (!ctx?.hasUI) return;
		const advisor = selectedAdvisor();
		const calls = advisor && ctx ? advisorCallCount(ctx.sessionManager.getBranch()) : 0;
		ctx.ui.setStatus("mixture", selected() ? session ? compactStatus(session, compacting) : advisor ? `executor · advisor ${calls}` : "handoff · unavailable · $?" : undefined);
	};
	const releaseRoleResources = (target = session) => {
		for (const helper of helpers) helper.abort(new Error("Mixture helper released"));
		if (target) for (const id of target.resourceSessionIds()) directSessionIds.add(id);
		if (directSessionIds.size) releaseProviderSessions(pi, [...directSessionIds]);
		directSessionIds.clear();
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
		advisorActive = false;
		stopAdvisorReminders();
		for (const helper of helpers) helper.abort(new Error(`Mixture ${reason}`));
		reservedAdvisorCalls.clear();
		const old = session;
		if (!old) { releaseRoleResources(); return; }
		await old.abort();
		await pending?.catch(() => {});
		releaseRoleResources(old);
		old.reconcile(reason);
		persist("detached");
		if (warn && ctx) {
			const warning = backgroundDetachWarning(queryBackgroundJobs(pi, rootId!));
			if (warning) ctx.ui.notify(warning, "warning");
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
		stopAdvisorReminders();
		const resourceIdentityChanged = reset || context.sessionManager.getSessionId() !== rootId || context.model?.provider !== "mixture" || ctx?.model?.provider !== "mixture" || ctx.model.id !== context.model.id;
		const handoffInvalid = session && (!context.model || session.state.preset !== context.model.id || config?.presets[context.model.id]?.mode !== "handoff");
		if ((session || directSessionIds.size || helpers.size) && (resourceIdentityChanged || handoffInvalid)) await detach("model or session changed", true);
		if (resourceIdentityChanged) lastAdvisorStartedAt = undefined;
		ctx = context;
		rootId = context.sessionManager?.getSessionId();
		registry = context.modelRegistry;
		const active = pi.getActiveTools().filter(name => name !== CONTROL && name !== ASK_ADVISOR);
		pi.setActiveTools(selectedHandoff() ? [...active, CONTROL] : selectedAdvisor() ? [...active, ASK_ADVISOR] : active);
		if (selectedHandoff()) ensureSession();
		render();
	};
	const inheritFastMode = (options?: SimpleStreamOptions): RoleStreamOptions | undefined => {
		const fast: { enabled?: boolean } = {};
		pi.events.emit("fast:query", fast);
		if (fast.enabled === undefined) return options;
		return { ...options, serviceTier: fast.enabled ? "priority" : "default" };
	};
	const ensureSession = () => {
		if (!selectedHandoff() || !ctx || !config) throw new Error("Select a Mixture handoff preset first");
		if (!session) {
			const name = ctx.model!.id;
			const preset = config.presets[name];
			if (preset.mode !== "handoff") throw new Error("Mixture preset is not in handoff mode");
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
			}, ctx.cwd, owner, scheduler);
			session = created;
			if (rootCompaction && created.state.rootCompactionId !== rootCompaction.id) {
				if (restored.state) created.rebaseLeadAfterCompaction(rootCompaction.id);
				else created.state.rootCompactionId = rootCompaction.id;
			}
			if (restored.state) created.reconcile("session restored");
			if (restored.warning) {
				created.state.warning = restored.warning;
				if (!restored.state) created.recordReset(restored.warning);
				ctx.ui.notify(restored.warning, "warning");
			}
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
					if (preset.mode === "advisor") {
						rootId = ctx.sessionManager.getSessionId();
						const message = await callRole(registry, preset.executor.model, context, preset.executor.thinking, {
							...inheritedOptions,
							timeoutMs: preset.limits.requestTimeoutMs,
							maxTokens: Math.min(inheritedOptions?.maxTokens ?? preset.limits.executorMaxTokens, preset.limits.executorMaxTokens),
							sessionId: requestLaneId(rootId, name, `${name}/executor`, "ordinary"),
						}, undefined, id => directSessionIds.add(id), scheduler);
						emitMessage(stream, message);
						return;
					}
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
				const role = preset.mode === "advisor" ? preset.executor : { model: preset.lead, thinking: undefined };
				const model = resolveModel(role.model, registry.find.bind(registry));
				const helperState = createLocalContext({ branchId: options?.sessionId ?? `helper-${randomUUID()}`, preset: name, role: "/helper" }, context.messages);
				const helperContext = { ...context, messages: helperState.activeMessages, tools: [] };
				const controller = new AbortController();
				helpers.add(controller);
				let acquiredId: string | undefined;
				try {
					const maxTokens = preset.mode === "advisor" ? preset.limits.executorMaxTokens : preset.limits.leadMaxTokens;
					const thinking = role.thinking ?? inheritedOptions?.reasoning ?? (model.reasoning ? ctx?.thinkingLevel ?? "high" : "off");
					emitMessage(stream, await callRole(registry, role.model, helperContext, thinking, {
						...inheritedOptions, sessionId: requestLaneId(options?.sessionId ?? "detached", randomUUID(), `${name}/helper`, "helper"), timeoutMs: preset.limits.requestTimeoutMs,
						signal: AbortSignal.any([controller.signal, ...(options?.signal ? [options.signal] : [])]),
						maxTokens: Math.min(inheritedOptions?.maxTokens ?? maxTokens, maxTokens),
					}, undefined, id => { acquiredId = id; }, scheduler));
				} finally {
					helpers.delete(controller);
					if (acquiredId) releaseProviderSessions(pi, [acquiredId]);
				}
			} catch (error) {
				if (options?.sessionId === rootId) { pending = undefined; requesting = false; }
				emitMessage(stream, failureMessage({ api: "mixture", provider: "mixture", id: name } as Model<any>, error, options?.signal?.aborted));
			}
		})();
		return stream;
	});
	pi.events?.on?.(LOCAL_CONTEXT_QUERY_EVENT, (value: unknown) => {
		const query = value as LocalContextQuery;
		if (!selected() || !session || query.sessionId !== rootId) return;
		query.target = session.localContextTarget();
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
	pi.registerTool({
		name: ASK_ADVISOR, label: "Advisor", description: advisorTool.description, parameters: AdvisorParams,
		execute: async (id, input: AdvisorInput, signal, _update, context) => {
			if (signal?.aborted) throw new Error("Advisor consultation cancelled");
			ctx = context;
			const preset = selectedAdvisor();
			if (!preset) throw new Error("Select a Mixture advisor preset first");
			const controller = new AbortController();
			helpers.add(controller);
			stopAdvisorReminders();
			const run = advisorRun;
			let acquiredId: string | undefined;
			try {
				const advice = await consultAdvisor(preset, registry, input, context, { ...inheritFastMode(), signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]) }, id => { acquiredId = id; }, scheduler);
				return { content: [{ type: "text" as const, text: advice.text }], details: { model: advice.model }, usage: advice.usage };
			} finally {
				helpers.delete(controller);
				if (acquiredId) releaseProviderSessions(pi, [acquiredId]);
				reservedAdvisorCalls.delete(id);
				// Success, failure and abort all get a full interval before another reminder.
				if (advisorActive && run === advisorRun) startAdvisorReminders(context, preset);
				render();
			}
		},
		renderCall: (args, theme, context) => controlCard(`Advisor review${args.question ? `\n${args.question}` : ""}`, context.expanded, theme),
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
					if (selectedHandoff()) ensureSession();
					if (action === "inspect" && context.mode === "tui") await context.ui.custom<void>((tui, theme, _keys, done) => new Inspector(status(), () => Math.min(30, tui.terminal.rows - 4), () => tui.requestRender(), () => done(), theme), { overlay: true, overlayOptions: { width: "100%", maxHeight: "90%" } });
					else context.ui.notify(status(), diagnostic ? "error" : "info");
					return;
				}
				if (session) {
					const activeSession = session;
					const jobs = queryBackgroundJobs(pi, rootId!);
					const tracked = Object.keys(activeSession.state.jobs);
					const running = jobs.jobs.some(job => job.status === "running" && Object.hasOwn(activeSession.state.jobs, job.id));
					if (running || tracked.length && (jobs.error || !jobs.available)) throw new Error("Reconcile Mixture's tracked background jobs before changing its configuration");
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
	pi.on("session_start", async (_event, context) => { reservedAdvisorCalls.clear(); await activate(context, true); if (diagnostic) context.ui.notify(diagnostic, "error"); });
	pi.on("model_select", (_event, context) => activate(context));
	pi.on("before_agent_start", async (event, context) => {
		await activate(context);
		if (selectedHandoff()) ensureSession().newRequest(event.prompt);
		const preset = selectedAdvisor();
		if (!preset) return;
		const guidelines = advisorGuidelines(preset, advisorCallCount(context.sessionManager.getBranch()) + reservedAdvisorCalls.size);
		const guidance = preset.executor.guidance ? `\n\nExecutor guidance:\n${preset.executor.guidance}` : "";
		return { systemPrompt: `${context.getSystemPrompt()}\n\nMixture advisor mode:\n${guidelines.map(rule => `- ${rule}`).join("\n")}${guidance}` };
	});
	pi.on("context", event => ({
		messages: event.messages.filter(message => message.role !== "custom" || message.customType !== "mixture-advisor-reminder" ||
			(advisorActive && advisorReminderId !== undefined && (message.details as any)?.reminderId === advisorReminderId)),
	}));
	pi.on("agent_start", () => {
		advisorActive = true;
		if (selectedHandoff()) session?.resumeLoop();
		else {
			const advisor = selectedAdvisor();
			if (advisor && ctx) startAdvisorReminders(ctx, advisor);
		}
	});
	pi.on("tool_call", event => {
		if (selectedHandoff()) {
			try { ensureSession().guard(event.toolCallId, event.toolName, event.input); }
			catch (error) { return { block: true, reason: String(error) }; }
			return;
		}
		const preset = selectedAdvisor();
		if (!preset || event.toolName !== ASK_ADVISOR) return;
		// Persisted message timestamps are wall-clock epoch milliseconds. The
		// injected scheduler may use a different test clock, so never compare the
		// two domains. Enforce each cooldown against its own clock instead.
		const persistedCooldown = ctx ? advisorCooldownMs(ctx.sessionManager.getBranch()) : 0;
		const now = scheduler.time();
		const inMemoryCooldown = lastAdvisorStartedAt === undefined ? 0
			: Math.max(0, MIN_ADVISOR_INTERVAL_MS - (now - lastAdvisorStartedAt));
		const cooldown = Math.max(persistedCooldown, inMemoryCooldown);
		if (cooldown) return { block: true, reason: `Advisor call throttled; try again in ${Math.ceil(cooldown / 1_000)} seconds` };
		lastAdvisorStartedAt = now;
		if (advisorActive && ctx) startAdvisorReminders(ctx, preset);
		reservedAdvisorCalls.add(event.toolCallId);
	});
	pi.on("tool_result", (event, context) => {
		reservedAdvisorCalls.delete(event.toolCallId);
		if (!session || context.sessionManager.getSessionId() !== rootId) { render(); return; }
		const nested = session.takeUsage();
		if (!nested.totalTokens && !nested.cost.total) return;
		const usage = structuredClone(event.usage ?? emptyUsage());
		addUsage(usage, nested);
		const details = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details : {};
		return { usage, details: { ...details, mixtureReceiptIds: [...new Set([...receiptIds(details), ...session.lastDrained])] } };
	});
	pi.on("message_end", async event => {
		if (!selectedHandoff() || !session || event.message.role !== "assistant" || !["aborted", "error"].includes(event.message.stopReason)) return;
		const usage = await session.drainAfterAbort();
		if (!usage.totalTokens && !usage.cost.total) return;
		addUsage(usage, event.message.usage);
		return { message: tagReceipts({ ...event.message, usage }, session.lastDrained) };
	});
	pi.on("turn_end", event => { if (selectedHandoff()) { session?.completeTurn(event.toolResults, event.message.role === "assistant" ? event.message : undefined); persist("turn"); } });
	pi.on("agent_end", async () => {
		advisorActive = false;
		stopAdvisorReminders();
		reservedAdvisorCalls.clear();
		if (session) { await session.abort(); releaseRoleResources(); session.reconcile("request ended"); persist("idle"); }
		else releaseRoleResources();
		// Pi also infers a resumed model from assistant identity. Mixture exposes the
		// underlying role there, so reaffirm the composite after the run settles.
		if (selected() && ctx?.model) await pi.setModel(ctx.model);
		render();
	});
	pi.on("session_before_switch", () => detach("session switch"));
	pi.on("session_before_fork", () => detach("session fork"));
	pi.on("session_before_tree", () => detach("tree navigation"));
	pi.on("session_tree", (_event, context) => activate(context, true));
	pi.on("session_before_compact", () => { compacting = true; render(); return detach("compaction"); });
	pi.on("session_compact", (_event, context) => { compacting = false; return activate(context, true); });
	pi.on("session_compact_failed", (_event, context) => { compacting = false; return activate(context, true); });
	pi.on("session_shutdown", async () => { reservedAdvisorCalls.clear(); await detach("session shutdown", true); releaseRoleResources(undefined); ctx = undefined; rootId = undefined; });
	if (config) {
		try { registered = buildProvider(config); pi.registerProvider(registered); }
		catch (error) { diagnostic = `Mixture registration failed: ${String(error)}`; }
	}
}

export default createMixtureExtension;
