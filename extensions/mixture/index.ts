import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { adaptToolForCodeMode, registerCodeModeExtensionTools } from "@howaboua/pi-codex-conversion/code-mode";
import { formatMixture, renderMixture, type MixtureOutput } from "./aggregate.ts";
import { loadConfig } from "./config.ts";
import { runMixture } from "./runner.ts";

const MixtureRunParams = Type.Object({
	task: Type.String({ description: "Task to delegate to each configured model" }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Per-worker timeout in milliseconds; defaults to timeoutMs in mixture.json" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the workers; defaults to the current directory" })),
});

interface MixtureCall {
	task: string;
	timeoutMs?: number;
	cwd?: string;
}

interface MixtureContext {
	thinkingLevel?: string;
	cwd: string;
}

export function createMixtureExtension(pi: ExtensionAPI, run = runMixture) {
	let codeRegistration: ReturnType<typeof registerCodeModeExtensionTools> | undefined;

	const executeTask = async (call: MixtureCall, ctx: MixtureContext): Promise<MixtureOutput> => {
		const task = call.task.trim();
		if (!task) throw new Error("task is required");
		const config = loadConfig();
		const results = await run({
			task,
			models: config.models,
			timeoutMs: call.timeoutMs ?? config.timeoutMs,
			thinking: ctx.thinkingLevel ?? "medium",
			cwd: call.cwd ?? ctx.cwd,
		});
		return formatMixture(task, results);
	};

	const mixtureRun = {
		name: "mixture_run",
		label: "Mixture Run",
		description: "Delegate the same task to each model in mixture.json in parallel worktrees and return every labeled output so the main thread can pick the best answer or combine the best parts.",
		parameters: MixtureRunParams,
		async execute(_toolCallId: string, params: MixtureCall, _signal: unknown, _onUpdate: unknown, ctx: MixtureContext) {
			const output = await executeTask(params, ctx);
			return {
				content: [{ type: "text" as const, text: renderMixture(output) }],
				details: { output },
			};
		},
	};

	pi.registerTool(mixtureRun as any);
	codeRegistration = registerCodeModeExtensionTools(pi, () => [
		adaptToolForCodeMode(mixtureRun as any, { usage: 'await tools.mixture_run({ task: "Implement the change" })' }),
	]);

	pi.registerCommand("mixture", {
		description: "Run the same task on every mixture.json model and combine the best parts",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /mixture <task>", "info");
				return;
			}
			const output = await executeTask({ task: args }, { thinkingLevel: pi.getThinkingLevel(), cwd: ctx.cwd });
			pi.sendMessage({
				content: renderMixture(output),
				display: true,
				details: { output },
			}, { deliverAs: "steer", triggerTurn: true });
		},
	});

	pi.on("session_shutdown", () => {
		codeRegistration?.unregister();
	});
}

export default createMixtureExtension;
