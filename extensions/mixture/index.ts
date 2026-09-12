import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ASYNC_JOB_COMPLETED_EVENT, type AsyncJobCompletedEvent } from "../subagent/events.ts";
import { loadConfig } from "./config.ts";
import { commandRun, reconnectRuns, sessionRuns, startRun } from "./client.ts";
import { inspectRun, renderInspection, summarizeRun } from "./inspect.ts";
import { readRun, runFile, terminal, writeJson } from "./state.ts";
import { stateHome } from "./runner.ts";
import { mixturePreview, renderMixtureCall, renderMixtureResult } from "./tool-render.ts";

const RunParams = Type.Object({
	task: Type.String({ description: "Task for each configured model" }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	cwd: Type.Optional(Type.String()),
});
const ProcessParams = Type.Object({
	action: StringEnum(["list", "inspect", "send", "stop", "restart", "resume"]),
	runId: Type.Optional(Type.String()),
	workerId: Type.Optional(Type.String({ description: "Worker slot, for example slot-0" })),
	message: Type.Optional(Type.String({ description: "Steering message" })),
});

export function createMixtureExtension(pi: ExtensionAPI, client = { startRun, commandRun, sessionRuns, readRun, reconnectRuns }) {
	let enabled = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const delivered = new Set<string>();
	const result = (value: unknown, path: string) => ({
		content: [{ type: "text" as const, text: renderInspection(value, path) }],
		details: { stateFile: path, preview: mixturePreview(value) },
	});
	const start = (params: { task: string; cwd?: string; timeoutMs?: number }, ctx: ExtensionContext) => {
		if (!enabled) throw new Error("Mixture is disabled. Run /mixture to enable it.");
		if (!params.task.trim()) throw new Error("task is required");
		const config = loadConfig();
		return client.startRun({ task: params.task.trim(), models: config.models,
			timeoutMs: params.timeoutMs ?? config.timeoutMs, cwd: params.cwd ?? ctx.cwd,
			thinking: pi.getThinkingLevel(),
		}, ctx.sessionManager.getSessionId());
	};
	const runTool = {
		name: "mixture_run", label: "Mixture Run",
		description: "Start parallel background model workers in retained worktrees. Returns a run ID immediately. Completion arrives automatically. Use mixture_process to inspect, steer, stop or restart.",
		parameters: RunParams,
		renderCall: (args: any, theme: any) => renderMixtureCall("mixture_run", args, theme),
		renderResult: renderMixtureResult,
		async execute(_id: string, params: typeof RunParams.static, _signal: unknown, _update: unknown, ctx: ExtensionContext) {
			const run = start(params, ctx);
			return result(summarizeRun(run), runFile(run.id));
		},
	};
	const processTool = {
		name: "mixture_process", label: "Mixture Process",
		description: "Manage durable mixture runs. List this session's runs; inspect retained outputs, usage, attempts and command acknowledgements. Send steers a running worker. Stop accepts an optional worker. Restart requires a worker. Resume explicitly transfers ownership to this session. Responses are bounded; full state stays on disk.",
		parameters: ProcessParams,
		renderCall: (args: any, theme: any) => renderMixtureCall("mixture_process", args, theme),
		renderResult: renderMixtureResult,
		async execute(_id: string, params: typeof ProcessParams.static, _signal: unknown, _update: unknown, ctx: ExtensionContext) {
			if (!enabled) throw new Error("Mixture is disabled. Run /mixture to enable it.");
			const session = ctx.sessionManager.getSessionId();
			if (params.action === "list") {
				const runs = client.sessionRuns(session).map(summarizeRun);
				const path = join(stateHome(), "listings", `${encodeURIComponent(session)}.json`);
				writeJson(path, runs);
				return result(runs, path);
			}
			if (!params.runId) throw new Error("runId is required");
			const path = runFile(params.runId);
			if (params.action === "inspect") return result(inspectRun(client.readRun(params.runId), params.workerId), path);
			if (["send", "restart"].includes(params.action) && !params.workerId) throw new Error("workerId is required");
			if (params.action === "send" && !params.message?.trim()) throw new Error("message is required");
			return result(client.commandRun(params.runId, session, params.action, params.workerId, params.message), path);
		},
	};
	pi.registerTool(runTool);
	pi.registerTool(processTool);
	pi.registerMessageRenderer("mixture-completion", (message, options, theme) => renderMixtureResult(message, options, theme));
	const monitor = (ctx: ExtensionContext) => {
		client.reconnectRuns(ctx.sessionManager.getSessionId());
		delivered.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom_message" && entry.customType === "mixture-completion") {
				const details = entry.details as { notificationId?: string } | undefined;
				if (details?.notificationId) delivered.add(details.notificationId);
			}
		}
		const scan = () => {
			for (const run of client.sessionRuns(ctx.sessionManager.getSessionId())) {
				for (const worker of run.workers) for (const attempt of worker.attempts) {
					const notificationId = `${run.id}/${worker.id}/${attempt.attempt}`;
					if (!terminal(attempt.status) || delivered.has(notificationId)) continue;
					pi.sendMessage({ customType: "mixture-completion", display: true,
						content: renderInspection({ runId: run.id, workerId: worker.id, model: worker.model,
							cwd: worker.cwd, branch: worker.branch, changes: worker.changes, ...attempt }, runFile(run.id)),
						details: { notificationId, stateFile: runFile(run.id), preview: mixturePreview({ runId: run.id, workerId: worker.id, model: worker.model, changes: worker.changes, ...attempt }) },
					}, { deliverAs: "steer", triggerTurn: true });
					delivered.add(notificationId);
					pi.events.emit(ASYNC_JOB_COMPLETED_EVENT, {
						source: "mixture", id: notificationId,
						status: attempt.status === "ok" ? "exited" : "failed",
					} satisfies AsyncJobCompletedEvent);
				}
			}
		};
		let lastError = "";
		const check = () => {
			try { scan(); lastError = ""; }
			catch (error) {
				const message = `Mixture completion check failed: ${String(error)}`;
				if (message !== lastError) ctx.ui.notify(message, "error");
				lastError = message;
			}
		};
		check();
		timer = setInterval(check, 1000);
		timer.unref();
	};
	const setEnabled = (value: boolean, ctx: ExtensionContext) => {
		enabled = value;
		if (timer) clearInterval(timer);
		timer = undefined;
		const active = new Set(pi.getActiveTools());
		for (const tool of [runTool, processTool]) {
			enabled ? active.add(tool.name) : active.delete(tool.name);
		}
		pi.setActiveTools([...active]);
		if (enabled) monitor(ctx);
	};
	pi.registerCommand("mixture", {
		description: "Toggle mixture tools and completion notifications for this session",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /mixture. Toggle it on, then ask the agent to run a mixture task.", "info");
				return;
			}
			setEnabled(!enabled, ctx);
			ctx.ui.notify(enabled ? "Mixture enabled" : "Mixture disabled. Existing workers keep running.", "info");
		},
	});
	pi.on("session_start", (_event, ctx) => setEnabled(false, ctx));
	pi.on("session_shutdown", () => {
		enabled = false;
		if (timer) clearInterval(timer);
	});
}

export default createMixtureExtension;
