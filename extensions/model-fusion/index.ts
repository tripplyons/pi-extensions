import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, DEFAULT_CONFIG, loadConfig, type Config } from "./config.ts";
import { addEvidence, createTask, evidencePacket, nextAction, parseVerdict, reserveEscalation, type Review, type Task } from "./policy.ts";
import { FRONTIER_PROMPT, requestAdvice, REVIEW_PROMPT } from "./requests.ts";

export default function (pi: ExtensionAPI) {
	let config: Config = DEFAULT_CONFIG;
	let enabled = false;
	let selecting = false;
	let task: Task | undefined;
	let pendingInputs: Array<{ text: string; source: string }> = [];
	let previous: { model: NonNullable<ExtensionContext["model"]>; thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> } | undefined;

	const status = (ctx: ExtensionContext, text: string) => ctx.ui.setStatus("model-fusion", enabled ? `fusion: ${text}` : undefined);
	const invalidate = () => {
		task?.controller.abort(new Error("Fusion task superseded"));
		task = undefined;
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
	const frontier = async (ctx: ExtensionContext, snapshot: Task, packet: string) => {
		const remaining = reserveEscalation(snapshot, Date.now());
		if (remaining) throw new Error(`Frontier cooldown: ${Math.ceil(remaining / 1000)} seconds remaining; do not wait just to retry`);
		status(ctx, "frontier advice");
		return requestAdvice(ctx, config.frontier, config, FRONTIER_PROMPT, packet, snapshot.controller.signal);
	};

	pi.registerCommand("fusion", {
		description: "Opt-in cheap-model fusion: on, off, status, reload",
		handler: async (args, ctx) => {
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
				selecting = true;
				try {
					if (!(await pi.setModel(actor))) throw new Error("Actor authentication unavailable");
					pi.setThinkingLevel(loaded.actor.reasoning);
				} finally {
					selecting = false;
				}
				if (!enabled) previous = selection;
				invalidate();
				config = loaded;
				enabled = true;
				pi.setActiveTools([...new Set([...pi.getActiveTools(), "fusion_escalate"])]);
				note(ctx, "on; selected task/tool evidence will be sent to configured reviewers");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
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
				const advice = await frontier(ctx, snapshot, evidencePacket(snapshot, problem));
				if (!current(snapshot)) throw new Error("Fusion task superseded");
				status(ctx, "frontier advice received");
				return { content: [{ type: "text", text: advice.text }], details: { model: config.frontier.model, reasoning: config.frontier.reasoning }, usage: advice.usage };
			} finally {
				signal?.removeEventListener("abort", abort);
				if (task === snapshot && snapshot.controller.signal.aborted) status(ctx, "cancelled");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => { deactivate(ctx); previous = undefined; });
	pi.on("session_before_switch", (_event, ctx) => { deactivate(ctx); previous = undefined; });
	pi.on("session_before_fork", (_event, ctx) => { deactivate(ctx); previous = undefined; });
	pi.on("session_before_tree", (_event, ctx) => { deactivate(ctx); previous = undefined; });
	pi.on("session_shutdown", (_event, ctx) => deactivate(ctx));
	pi.on("model_select", (_event, ctx) => {
		if (!enabled || selecting) return;
		deactivate(ctx);
		previous = undefined;
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
		if (!enabled || event.message.role !== "user") return;
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
	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => message.role !== "custom" || message.customType !== "model-fusion" || (enabled && task && !task.controller.signal.aborted && (message.details as { taskId?: string } | undefined)?.taskId === task.id)),
	}));
	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\nFusion mode: You are the sole tool-using actor. Your proposed completion will be independently reviewed. Treat review and frontier advice as fallible; verify concrete claims with tools. Use fusion_escalate only for a genuine unresolved blocker. Never wait out its cooldown. Do not claim a review or test passed unless it did.` };
	});
	pi.on("tool_result", (event) => {
		if (!enabled || !task) return;
		const text = event.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		const input = ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(event.toolName) ? JSON.stringify(event.input) : "[custom tool arguments omitted]";
		addEvidence(task, `Tool: ${event.toolName}; error: ${event.isError}\nInput: ${input}\nOutput: ${text}`);
	});
	pi.on("turn_end", async (event, ctx) => {
		const snapshot = task;
		if (!enabled || !snapshot || snapshot.phase === "done") return;
		if (event.message.role !== "assistant" || event.message.stopReason !== "stop" || event.message.content.some((block) => block.type === "toolCall")) return;
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
			const candidate = event.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
			const packet = evidencePacket(snapshot, candidate);
			const reviews: Review[] = await Promise.all(config.reviewers.map(async (slot) => {
				const model = `${slot.provider}/${slot.model}`;
				try {
					const advice = await requestAdvice(ctx, slot, config, REVIEW_PROMPT, packet, snapshot.controller.signal);
					return { model, verdict: parseVerdict(advice.text) };
				} catch (error) {
					return { model, error: error instanceof Error ? error.message : String(error) };
				}
			}));
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
				followUp(snapshot, `Independent review found unresolved issues. Verify these fallible findings, fix concrete defects, and run relevant checks. This is the one cheap repair round.\n${findings}`);
				return;
			}
			snapshot.phase = "frontier";
			const advice = await frontier(ctx, snapshot, evidencePacket(snapshot, `${candidate}\n\nREVIEW FINDINGS\n${findings}`));
			if (!current(snapshot)) return;
			pi.appendEntry("model-fusion-frontier", { model: config.frontier.model, reasoning: config.frontier.reasoning });
			followUp(snapshot, `Frontier advice (fallible; verify with tools). Perform one final repair/check pass, then report any unresolved issues honestly.\n${advice.text}`);
		} catch (error) {
			if (!current(snapshot)) return;
			snapshot.phase = "done";
			note(ctx, `review incomplete: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			signal?.removeEventListener("abort", abort);
			if (task === snapshot && snapshot.controller.signal.aborted) status(ctx, "cancelled");
		}
	});
}
