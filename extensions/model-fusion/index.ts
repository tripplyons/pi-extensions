import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, DEFAULT_CONFIG, loadConfig, type Config } from "./config.ts";
import { createTask, evidencePacket, nextAction, parseVerdict, reserveEscalation, type ContextMessage, type Review, type Task } from "./policy.ts";
import { FRONTIER_PROMPT, requestAdvice, REVIEW_PROMPT } from "./requests.ts";

export default function (pi: ExtensionAPI) {
	let config: Config = DEFAULT_CONFIG;
	let enabled = false;
	let selecting = false;
	let task: Task | undefined;
	let toolCalls = 0;
	let mainContext: ContextMessage[] = [];
	let reviewedThrough = 0;
	const progressRequests = new Set<AbortController>();
	const cancelProgress = () => {
		for (const controller of progressRequests) controller.abort(new Error("Progress review superseded"));
		progressRequests.clear();
	};
	let pendingInputs: Array<{ text: string; source: string }> = [];
	let previous: { model: NonNullable<ExtensionContext["model"]>; thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> } | undefined;

	const status = (ctx: ExtensionContext, text: string) => {
		ctx.ui.setStatus("model-fusion", enabled ? "fusion on" : undefined);
		ctx.ui.setStatus("model-fusion-progress", enabled ? text : undefined);
	};
	const persist = () => pi.appendEntry("model-fusion-state", {
		enabled,
		previous: previous ? { provider: previous.model.provider, model: previous.model.id, thinking: previous.thinking } : undefined,
	});
	const invalidate = () => {
		cancelProgress();
		reviewedThrough = 0;
		task?.controller.abort(new Error("Fusion task superseded"));
		task = undefined;
		toolCalls = 0;
	};
	const deactivate = (ctx: ExtensionContext) => {
		enabled = false;
		pendingInputs = [];
		invalidate();
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "fusion_escalate"));
		status(ctx, "off");
	};
	const current = (snapshot: Task) => enabled && task === snapshot && !snapshot.controller.signal.aborted;
	const note = (ctx: ExtensionContext, text: string) => {
		status(ctx, text);
		ctx.ui.notify(`Fusion: ${text}`, "info");
	};
	const followUp = (snapshot: Task, content: string) => {
		if (!current(snapshot)) return;
		pi.sendMessage({ customType: "model-fusion", content, display: true, details: { taskId: snapshot.id } }, { deliverAs: "followUp", triggerTurn: true });
	};
	const collectReviews = (ctx: ExtensionContext, snapshot: Task, packet: string, signal = snapshot.controller.signal): Promise<Review[]> => Promise.all(config.reviewers.map(async (slot) => {
		const model = `${slot.provider}/${slot.model}`;
		try {
			const advice = await requestAdvice(ctx, slot, config, REVIEW_PROMPT, packet, signal);
			return { model, verdict: parseVerdict(advice.text) };
		} catch (error) {
			return { model, error: error instanceof Error ? error.message : String(error) };
		}
	}));
	const frontier = async (ctx: ExtensionContext, snapshot: Task, packet: string) => {
		const remaining = reserveEscalation(snapshot, Date.now());
		if (remaining) throw new Error(`Frontier cooldown: ${Math.ceil(remaining / 1000)} seconds remaining; do not wait just to retry`);
		status(ctx, "frontier advice");
		return requestAdvice(ctx, config.frontier, config, FRONTIER_PROMPT, packet, snapshot.controller.signal);
	};

	const configure = async (args: string, ctx: ExtensionContext, restored?: typeof previous) => {
			const action = args.trim() || "status";
			if (action === "status") {
				ctx.ui.notify(`Fusion ${enabled ? "on" : "off"}; actor ${config.actor.provider}/${config.actor.model}; phase ${task?.phase ?? "idle"}; config ${CONFIG_PATH}`, "info");
				return;
			}
			if (!["on", "off", "reload"].includes(action)) {
				ctx.ui.notify("Usage: /fusion on|off|status|reload", "warning");
				return;
			}
			if (!ctx.isIdle() && action !== "off") {
				ctx.ui.notify("Wait for Pi to become idle before changing fusion configuration", "warning");
				return;
			}
			try {
				if (action === "off") {
					deactivate(ctx);
					persist();
					if (previous) {
						if (!(await pi.setModel(previous.model))) throw new Error("Fusion disabled, but prior model authentication is unavailable");
						pi.setThinkingLevel(previous.thinking);
						previous = undefined;
					}
					return;
				}
				if (action === "on" && enabled) return;
				const loaded = await loadConfig();
				for (const slot of [loaded.actor, ...loaded.reviewers, loaded.frontier]) {
					const model = ctx.modelRegistry.find(slot.provider, slot.model);
					if (!model) throw new Error(`Model unavailable: ${slot.provider}/${slot.model}`);
					if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Authentication unavailable: ${slot.provider}`);
				}
				if (action === "reload" && !enabled) {
					config = loaded;
					ctx.ui.notify("Fusion configuration reloaded", "info");
					return;
				}
				if (!ctx.model) throw new Error("No active model to restore after fusion");
				const selection = { model: ctx.model, thinking: pi.getThinkingLevel() };
				const actor = ctx.modelRegistry.find(loaded.actor.provider, loaded.actor.model)!;
				const checkpoint = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "compaction" || (entry.type === "custom" && entry.customType === "openai-codex-native-compaction"));
				const details = checkpoint?.type === "compaction" ? checkpoint.details : checkpoint?.type === "custom" ? checkpoint.data : undefined;
				const native = details as { kind?: string; modelKey?: string } | undefined;
				if (native?.kind === "openai-codex-native-compaction" && native.modelKey !== `${actor.provider}:${actor.api}:${actor.id}`) {
					throw new Error("Fusion cannot switch this native-compacted session to its actor. Start a new session and enable /fusion on before working, or configure the actor to match the checkpoint model.");
				}
				selecting = true;
				try {
					if (!(await pi.setModel(actor))) throw new Error("Actor authentication unavailable");
					pi.setThinkingLevel(loaded.actor.reasoning);
				} finally {
					selecting = false;
				}
				if (!enabled) previous = restored ?? selection;
				invalidate();
				config = loaded;
				enabled = true;
				persist();
				pi.setActiveTools([...new Set([...pi.getActiveTools(), "fusion_escalate"])]);
				note(ctx, "on; selected task/tool evidence will be sent to configured reviewers");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
	};
	pi.registerCommand("fusion", {
		description: "Opt-in cheap-model fusion: on, off, status, reload",
		handler: (args, ctx) => configure(args, ctx),
	});

	pi.registerTool({
		name: "fusion_escalate",
		label: "Frontier advice",
		description: "Ask a tool-free frontier advisor for help with a concrete blocker. Luna remains the actor. One immediate call per user prompt; further calls require five minutes. Do not wait for the cooldown or use this for routine work.",
		parameters: Type.Object({ problem: Type.String({ description: "Concrete unresolved issue and what has already been tried", minLength: 1, maxLength: 8000 }) }),
		execute: async (_id, { problem }, signal, _update, ctx) => {
			const snapshot = task;
			if (!enabled || !snapshot) throw new Error("Fusion is not active for a user prompt");
			const abort = () => snapshot.controller.abort(signal?.reason);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			try {
				snapshot.controller.signal.throwIfAborted();
				const advice = await frontier(ctx, snapshot, evidencePacket(mainContext, problem));
				if (!current(snapshot)) throw new Error("Fusion task superseded");
				status(ctx, "frontier advice received");
				return { content: [{ type: "text", text: advice.text }], details: { model: config.frontier.model, reasoning: config.frontier.reasoning }, usage: advice.usage };
			} finally {
				signal?.removeEventListener("abort", abort);
				if (task === snapshot && snapshot.controller.signal.aborted) status(ctx, "cancelled");
			}
		},
	});

	const restore = async (ctx: ExtensionContext) => {
		deactivate(ctx);
		previous = undefined;
		const entry = [...ctx.sessionManager.getEntries()].reverse().find((entry) => entry.type === "custom" && entry.customType === "model-fusion-state");
		if (entry?.type !== "custom") {
			if (process.env.PI_SWARM_FUSION === "on") await configure("on", ctx);
			return;
		}
		const stored = entry.data as { enabled?: boolean; previous?: { provider: string; model: string; thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> } };
		if (stored?.enabled !== true) return;
		const model = stored.previous && ctx.modelRegistry.find(stored.previous.provider, stored.previous.model);
		await configure("on", ctx, model && stored.previous ? { model, thinking: stored.previous.thinking } : undefined);
	};
	pi.on("session_start", (_event, ctx) => { mainContext = []; return restore(ctx); });
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_before_switch", (_event, ctx) => { deactivate(ctx); previous = undefined; });
	pi.on("session_before_fork", (_event, ctx) => { deactivate(ctx); previous = undefined; });
	pi.on("session_before_tree", (_event, ctx) => { deactivate(ctx); previous = undefined; });
	pi.on("session_shutdown", (_event, ctx) => deactivate(ctx));
	pi.on("model_select", (_event, ctx) => {
		if (!enabled || selecting) return;
		deactivate(ctx);
		previous = undefined;
		persist();
		ctx.ui.notify("Fusion disabled after model selection changed", "info");
	});
	pi.on("input", (event, ctx) => {
		if (!enabled) return;
		pendingInputs.push({ text: event.text, source: event.source });
		if (event.source === "extension") return;
		invalidate();
		status(ctx, "awaiting user prompt delivery");
	});
	pi.on("message_start", (event, ctx) => {
		if (!enabled) return;
		if (event.message.role === "custom" && ["goal-continuation", "goal-objective-updated"].includes(event.message.customType)) {
			const content = event.message.content;
			const prompt = typeof content === "string" ? content : content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
			if (!task) task = createTask(prompt);
			else {
				if (task.phase === "done") task.phase = "draft";
			}
			status(ctx, task.phase);
			return;
		}
		if (event.message.role !== "user") return;
		const content = event.message.content;
		const text = typeof content === "string" ? content : content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		// Match queued prompts by text; expanded skills/templates consume the oldest input.
		const match = pendingInputs.findIndex((input) => input.text === text);
		const [input] = pendingInputs.splice(match < 0 ? 0 : match, 1);
		if (input?.source === "extension") return;
		invalidate();
		task = createTask(text);
		status(ctx, "draft");
	});
	pi.on("context", (event) => {
		const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== "model-fusion" || (enabled && task && !task.controller.signal.aborted && (message.details as { taskId?: string } | undefined)?.taskId === task.id));
		mainContext = [...messages];
		return { messages };
	});
	pi.on("message_end", (event) => {
		mainContext.push(event.message);
	});
	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\nFusion mode: You are the sole tool-using actor. Your proposed completion will be independently reviewed. Treat review and frontier advice as fallible; verify concrete claims with tools. Use fusion_escalate only for a genuine unresolved blocker. Never wait out its cooldown. Do not claim a review or test passed unless it did.` };
	});
	const reviewCompletion = async (candidate: string, ctx: ExtensionContext): Promise<string | undefined> => {
		cancelProgress();
		reviewedThrough = toolCalls;
		const snapshot = task;
		if (!enabled || !snapshot || snapshot.phase === "done") return;
		if (snapshot.phase === "frontier") {
			snapshot.phase = "done";
			note(ctx, "bounded review cycle ended; final repair is not independently re-reviewed");
			return;
		}
		const abort = () => snapshot.controller.abort(ctx.signal?.reason);
		const signal = ctx.signal;
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			if (!current(snapshot)) return;
			status(ctx, "reviewing draft");
			const packet = evidencePacket(mainContext, candidate);
			const reviews = await collectReviews(ctx, snapshot, packet);
			if (!current(snapshot)) return;
			pi.appendEntry("model-fusion-review", { phase: snapshot.phase, reviews });
			const action = nextAction(snapshot.phase, reviews);
			const degraded = reviews.some((review) => review.error);
			if (action === "pass") {
				snapshot.phase = "done";
				note(ctx, degraded ? "review passed with unavailable reviewers (degraded)" : "review passed");
				return;
			}
			const findings = JSON.stringify(reviews);
			if (action === "repair") {
				snapshot.phase = "repair";
				status(ctx, degraded ? "repair (degraded review)" : "repair");
				return `Independent review found unresolved issues. Verify these fallible findings, fix concrete defects, and run relevant checks. This is the one cheap repair round.\n${findings}`;
			}
			snapshot.phase = "frontier";
			const advice = await frontier(ctx, snapshot, evidencePacket(mainContext, `${candidate}\n\nREVIEW FINDINGS\n${findings}`));
			if (!current(snapshot)) return;
			pi.appendEntry("model-fusion-frontier", { model: config.frontier.model, reasoning: config.frontier.reasoning });
			return `Frontier advice (fallible; verify with tools). Perform one final repair/check pass, then report any unresolved issues honestly.\n${advice.text}`;
		} catch (error) {
			if (!current(snapshot)) return;
			snapshot.phase = "done";
			note(ctx, `review incomplete: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			signal?.removeEventListener("abort", abort);
			if (task === snapshot && snapshot.controller.signal.aborted) status(ctx, "cancelled");
		}
	};
	const reviewProgress = async (ctx: ExtensionContext, snapshot: Task, fromCall: number, throughCall: number) => {
		const startedAt = Date.now();
		const controller = new AbortController();
		const signal = ctx.signal;
		const abort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		progressRequests.add(controller);
		try {
			status(ctx, `background review through tool call ${throughCall}`);
			const packet = evidencePacket(mainContext, "Work is still in progress, not a proposed completion. Review recent tool evidence for concrete mistakes or a wrong approach. Do not request completion merely because the task is unfinished.");
			const reviews = await collectReviews(ctx, snapshot, packet, controller.signal);
			if (!current(snapshot) || controller.signal.aborted) return;
			const finishedAt = Date.now();
			const timing = { startedAt, finishedAt, elapsedMs: finishedAt - startedAt, fromCall, throughCall, deliveredAtCall: toolCalls };
			const actionable = reviews.some((review) => review.verdict && review.verdict.verdict !== "pass");
			const outcome = actionable ? "findings" : reviews.some((review) => review.error) ? "incomplete/degraded" : "passed";
			pi.appendEntry("model-fusion-review", { taskId: snapshot.id, phase: "progress", timing, reviews });
			const content = `Background progress review: ${outcome}. Snapshot after tool call ${throughCall} (checkpoint interval ${fromCall}–${throughCall}), started ${new Date(startedAt).toISOString()}, finished ${new Date(finishedAt).toISOString()} (${(timing.elapsedMs / 1000).toFixed(1)}s); actor has since completed ${toolCalls - throughCall} more tool calls.\n${actionable ? "Findings are fallible and may already be addressed by newer work. Verify against current state; do not repeat fixes or finish merely because this review arrived." : "Informational result only; no reply or extra work is requested."}\n${JSON.stringify(reviews)}`;
			pi.sendMessage({ customType: "model-fusion", content, display: true, details: { taskId: snapshot.id, timing } }, { deliverAs: "steer", triggerTurn: actionable });
			note(ctx, `progress review ${outcome} (${(timing.elapsedMs / 1000).toFixed(1)}s)`);
		} catch (error) {
			if (current(snapshot) && !controller.signal.aborted) note(ctx, `progress review failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			signal?.removeEventListener("abort", abort);
			progressRequests.delete(controller);
		}
	};
	pi.on("turn_end", async (event, ctx) => {
		if (enabled && task && event.message.role === "assistant" && event.message.stopReason === "toolUse" && !ctx.signal?.aborted && !event.toolResults.some((result) => "terminate" in result && result.terminate)) {
			toolCalls += event.toolResults.length;
			if (toolCalls - reviewedThrough < config.reviewEveryToolCalls) return;
			const fromCall = reviewedThrough + 1;
			reviewedThrough = toolCalls;
			void reviewProgress(ctx, task, fromCall, toolCalls);
			return;
		}
		if (event.message.role !== "assistant" || event.message.stopReason !== "stop" || event.message.content.some((block) => block.type === "toolCall")) return;
		const snapshot = task;
		const advice = await reviewCompletion(event.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"), ctx);
		if (snapshot && advice) followUp(snapshot, advice);
	});
	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || event.toolName !== "update_goal" || !["complete", "blocked"].includes(String(event.input.status))) return;
		if (!task) task = createTask("Review the active goal before its terminating status update.");
		const goal = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === "goal-state");
		const advice = await reviewCompletion(`Actor requests update_goal: ${JSON.stringify(event.input)}\nActive goal: ${goal?.type === "custom" ? JSON.stringify(goal.data) : "not recorded"}`, ctx);
		if (advice) return { block: true, reason: advice };
	});
}
