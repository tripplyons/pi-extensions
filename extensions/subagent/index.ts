import { spawn } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ThinkingLevel } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { adaptToolForCodeMode, registerCodeModeExtensionTools } from "@howaboua/pi-codex-conversion/code-mode";
import { ASYNC_JOB_COMPLETED_EVENT, type AsyncJobCompletedEvent } from "./events.ts";
import {
	startAgentRun,
	type AgentActivity,
	type AgentRunOptions,
	type AgentRunStatus,
	type AgentUsage,
	type RunningAgent,
	type SpawnChild,
} from "./runner.ts";

const MAX_DELIVERY_CHARS = 12_000;
const MAX_TOOL_OUTPUT_CHARS = 50_000;

interface PublicSubagentJob {
	id: string;
	pid: number;
	task: string;
	cwd: string;
	model?: string;
	thinking: ThinkingLevel;
	status: AgentRunStatus;
	exitCode: number | null;
	startedAt: number;
	endedAt: number | null;
	lastActivityAt: number;
	activity: AgentActivity;
	currentTool?: string;
	completedToolCount: number;
	output: string;
	stderr: string;
	protocolDiagnostics: string;
	error?: string;
	reason?: "killed";
	usage: AgentUsage;
}

interface SubagentJob {
	id: string;
	run: RunningAgent;
}

interface SubagentToolDetails {
	job: PublicSubagentJob;
}

interface OutputRange {
	offset: number;
	end: number;
	limit: number;
	total: number;
}

interface SubagentProcessDetails {
	action: "list" | "output" | "kill" | "clear";
	jobs: PublicSubagentJob[];
	range?: OutputRange;
}

interface CompletionMessageDetails {
	job: PublicSubagentJob;
}

const SubagentParams = Type.Object({
	task: Type.String({ description: "Self-contained task to delegate" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child; defaults to the current directory" })),
	model: Type.Optional(Type.String({ description: "Model override; defaults to the parent model" })),
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
});

const SubagentProcessParams = Type.Object({
	action: StringEnum(["list", "output", "kill", "clear"] as const),
	id: Type.Optional(Type.String({ description: "Subagent job id for output or kill" })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based character offset for output" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TOOL_OUTPUT_CHARS, description: `Maximum characters to return; defaults to ${MAX_TOOL_OUTPUT_CHARS}` })),
});

const headTailExcerpt = (text: string, limit: number) => {
	if (text.length <= limit) return text;
	const marker = "\n\n[Middle omitted. Use subagent_process output to retrieve the retained result.]\n\n";
	const available = Math.max(0, limit - marker.length);
	const headLength = Math.ceil(available / 2);
	const tailLength = Math.floor(available / 2);
	return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
};

const publicJob = (job: SubagentJob): PublicSubagentJob => ({
	id: job.id,
	...job.run.snapshot(),
});

const jobResultText = (job: PublicSubagentJob) => {
	const diagnostics = [
		job.error && `Error: ${job.error}`,
		job.stderr && `stderr:\n${job.stderr}`,
		job.protocolDiagnostics && `Protocol diagnostics:\n${job.protocolDiagnostics}`,
	].filter(Boolean);
	if (job.output) diagnostics.push(`${diagnostics.length ? "Output:\n" : ""}${job.output}`);
	return diagnostics.join("\n\n") || (job.status === "exited" ? "(no output)" : "(no diagnostics)");
};

const formatDuration = (milliseconds: number) => {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (totalSeconds < 1) return "<1s";
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 1) return `${seconds}s`;
	const minutes = totalMinutes % 60;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 1) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	return `${totalHours}h ${minutes.toString().padStart(2, "0")}m`;
};

const outputRange = (text: string, offset: number | undefined, limit: number | undefined): { text: string; range: OutputRange } => {
	if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) throw new Error("offset must be a non-negative integer");
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_TOOL_OUTPUT_CHARS)) {
		throw new Error(`limit must be an integer from 1 to ${MAX_TOOL_OUTPUT_CHARS}`);
	}
	const effectiveLimit = limit ?? MAX_TOOL_OUTPUT_CHARS;
	const effectiveOffset = offset ?? Math.max(0, text.length - effectiveLimit);
	if (effectiveOffset > text.length) throw new Error(`offset ${effectiveOffset} exceeds retained output length ${text.length}`);
	const end = Math.min(text.length, effectiveOffset + effectiveLimit);
	return {
		text: text.slice(effectiveOffset, end),
		range: { offset: effectiveOffset, end, limit: effectiveLimit, total: text.length },
	};
};

class SubagentManager {
	private jobs = new Map<string, SubagentJob>();
	private nextId = 1;
	private shuttingDown = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly spawnChild: SpawnChild,
	) {}

	start(options: AgentRunOptions) {
		if (this.shuttingDown) throw new Error("Subagent manager is shutting down");

		const id = `sub_${this.nextId++}`;
		const job = { id, run: startAgentRun(options, this.spawnChild) };
		this.jobs.set(id, job);
		void job.run.completion.then(() => {
			if (!this.shuttingDown) this.deliver(job);
		});
		return publicJob(job);
	}

	list() {
		return [...this.jobs.values()]
			.map(publicJob)
			.sort((left, right) => right.startedAt - left.startedAt);
	}

	output(id: string) {
		return publicJob(this.requireJob(id));
	}

	async kill(id: string) {
		const job = this.requireJob(id);
		await job.run.kill();
		return publicJob(job);
	}

	clearFinished() {
		let count = 0;
		for (const [id, job] of this.jobs) {
			if (job.run.snapshot().status === "running") continue;
			this.jobs.delete(id);
			count++;
		}
		return count;
	}

	async cleanup() {
		this.shuttingDown = true;
		const running = [...this.jobs.values()].filter((job) => job.run.snapshot().status === "running");
		await Promise.all(running.map((job) => job.run.kill()));
		this.jobs.clear();
	}

	private requireJob(id: string) {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Unknown subagent job: ${id}`);
		return job;
	}

	private deliver(job: SubagentJob) {
		const snapshot = publicJob(job);
		const status = snapshot.status === "exited" ? "completed" : snapshot.status;
		this.pi.sendMessage<CompletionMessageDetails>({
			customType: "subagent-completion",
			content: `Subagent ${job.id} ${status}.\n${formatJob(snapshot)}\n\n${headTailExcerpt(jobResultText(snapshot), MAX_DELIVERY_CHARS)}`,
			display: true,
			details: { job: snapshot },
		}, { deliverAs: "steer", triggerTurn: true });
		this.pi.events.emit(ASYNC_JOB_COMPLETED_EVENT, {
				source: "subagent",
				id: job.id,
				status: snapshot.status,
		} satisfies AsyncJobCompletedEvent);
	}
}

const formatJob = (job: PublicSubagentJob, observedAt = Date.now()) => {
	const exit = job.exitCode === null ? "" : `:${job.exitCode}`;
	const elapsed = (job.endedAt ?? observedAt) - job.startedAt;
	const inactive = Math.max(0, (job.endedAt ?? observedAt) - job.lastActivityAt);
	const tool = job.currentTool ? ` tool=${job.currentTool}` : "";
	return `${job.id} pid=${job.pid} ${job.status}${exit} elapsed=${formatDuration(elapsed)} activity=${job.activity}${tool} completedTools=${job.completedToolCount} inactive=${formatDuration(inactive)} task=${job.task}`;
};

const processResult = (
	action: SubagentProcessDetails["action"],
	text: string,
	jobs: PublicSubagentJob[],
	range?: OutputRange,
) => ({
	content: [{ type: "text" as const, text }],
	details: { action, jobs, ...(range ? { range } : {}) } satisfies SubagentProcessDetails,
});

export function createSubagentExtension(pi: ExtensionAPI, spawnChild: SpawnChild = spawn) {
	const manager = new SubagentManager(pi, spawnChild);

	pi.on("session_shutdown", async () => manager.cleanup());

	pi.registerMessageRenderer<CompletionMessageDetails>("subagent-completion", (message, { expanded }, theme) => {
		const job = message.details?.job;
		if (!job) return new Text(message.content, 0, 0);
		const icon = job.status === "exited" ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const header = `${icon} ${theme.fg("accent", job.id)} ${theme.fg("muted", job.status)} ${theme.fg("dim", job.task)}`;
		if (!expanded) return new Text(header, 0, 0);
		return new Text(`${header}\n\n${theme.fg("toolOutput", headTailExcerpt(jobResultText(job), MAX_DELIVERY_CHARS))}`, 0, 0);
	});

	const subagent = defineTool({
		name: "subagent",
		label: "Subagent",
		description: "Start an asynchronous, session-scoped Pi subagent with isolated context. Returns a job id immediately. The child inherits the parent model and thinking level, loads Codex conversion with full Code tools, and runs without session persistence. It can edit files and run shell commands. Completion is delivered automatically.",
		promptSnippet: "Start an isolated asynchronous Pi subagent and receive its result automatically",
		promptGuidelines: [
			"Use subagent for independent research or delegated work that benefits from an isolated context window.",
			"Subagent starts asynchronously; do other useful work instead of polling repeatedly.",
		],
		parameters: SubagentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = params.task.trim();
			if (!task) throw new Error("task is required");
			const model = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			const job = manager.start({
				task,
				cwd: params.cwd ?? ctx.cwd,
				model,
				thinking: params.thinking ?? ctx.thinkingLevel,
			});
			return {
				content: [{ type: "text" as const, text: `Started ${job.id} (pid ${job.pid}). Result will be delivered automatically.` }],
				details: { job } satisfies SubagentToolDetails,
			};
		},
		renderCall(args, theme) {
			const preview = args.task?.length > 80 ? `${args.task.slice(0, 80)}…` : args.task;
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("dim", preview || "…")}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as SubagentToolDetails | undefined;
			return new Text(theme.fg("muted", details ? `started ${formatJob(details.job)}` : "failed to start"), 0, 0);
		},
	});

	const subagentProcess = defineTool({
		name: "subagent_process",
		label: "Subagent Process",
		description: "Manage session-scoped asynchronous subagents. Actions: list, output (id, optional character offset/limit), kill (id), clear. Output defaults to the final retained chunk. Completion results are delivered automatically.",
		promptSnippet: "List, inspect, kill, or clear asynchronous subagent jobs",
		promptGuidelines: ["Use subagent_process to inspect or stop subagent jobs; do not poll jobs whose completion will be delivered automatically."],
		parameters: SubagentProcessParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const jobs = manager.list();
					return processResult("list", jobs.length ? jobs.map(formatJob).join("\n") : "No subagent jobs", jobs);
				}
				case "output": {
					if (!params.id) throw new Error("id is required for output");
					const job = manager.output(params.id);
					const output = outputRange(jobResultText(job), params.offset, params.limit);
					const range = `Output characters ${output.range.offset}:${output.range.end} of ${output.range.total}`;
					return processResult("output", `${formatJob(job)}\n${range}\n\n${output.text}`, [job], output.range);
				}
				case "kill": {
					if (!params.id) throw new Error("id is required for kill");
					const job = await manager.kill(params.id);
					return processResult("kill", `${formatJob(job)}`, [job]);
				}
				case "clear": {
					const count = manager.clearFinished();
					return processResult("clear", `Cleared ${count} finished subagent job(s)`, manager.list());
				}
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_process"))} ${theme.fg("muted", args.action)}${args.id ? ` ${theme.fg("accent", args.id)}` : ""}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	pi.registerTool(subagent);
	pi.registerTool(subagentProcess);
	const registration = registerCodeModeExtensionTools(pi, () => [
		adaptToolForCodeMode(subagent, { usage: 'await tools.subagent({ task: "Research the issue" })' }),
		adaptToolForCodeMode(subagentProcess, { usage: 'await tools.subagent_process({ action: "list" })' }),
	]);
	pi.on("session_shutdown", () => registration.unregister());
}

export default createSubagentExtension;
