import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-coding-agent";

const MAX_CAPTURE_CHARS = 1_000_000;
const MAX_DIAGNOSTIC_CHARS = 50_000;
const KILL_GRACE_MS = 2_000;
const KILL_FINALIZATION_MS = 2_000;
const OMITTED_MARKER = "[earlier output omitted]\n";

const debug = (event: string, details: Record<string, unknown>) => {
	if (process.env.PI_WORKFLOW_DEBUG !== "1" && process.env.PI_SUBAGENT_DEBUG !== "1") return;
	console.error(`[subagent-runner] ${event} ${JSON.stringify(details)}`);
};

export type SpawnChild = typeof spawn;
export type AgentRunStatus = "running" | "exited" | "failed" | "killed";
export type AgentActivity = "started" | "turn_start" | "message_update" | "tool_execution_start" | "tool_execution_end" | "message_end";

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface AgentRunOptions {
	task: string;
	cwd: string;
	model?: string;
	thinking: ThinkingLevel;
}

export interface AgentRunSnapshot extends AgentRunOptions {
	pid: number;
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

export interface RunningAgent {
	pid: number;
	completion: Promise<AgentRunSnapshot>;
	snapshot: () => AgentRunSnapshot;
	kill: () => Promise<AgentRunSnapshot>;
}

const emptyUsage = (): AgentUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	turns: 0,
});

const appendCapped = (current: string, addition: string, limit: number) => {
	const wasOmitted = current.startsWith(OMITTED_MARKER);
	const combined = `${wasOmitted ? current.slice(OMITTED_MARKER.length) : current}${addition}`;
	if (!wasOmitted && combined.length <= limit) return combined;
	if (wasOmitted && OMITTED_MARKER.length + combined.length <= limit) return `${OMITTED_MARKER}${combined}`;
	if (limit <= OMITTED_MARKER.length) return combined.slice(-limit);
	return `${OMITTED_MARKER}${combined.slice(-(limit - OMITTED_MARKER.length))}`;
};

const textFromAssistant = (message: any) => {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
};

export const getPiInvocation = (args: string[]) => {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
};

const processTarget = (pid: number) => process.platform === "win32" ? pid : -pid;

const signalProcess = (child: ChildProcess, pid: number, signal: NodeJS.Signals) => {
	if (pid <= 0) {
		child.kill(signal);
		return;
	}
	try {
		process.kill(processTarget(pid), signal);
	} catch {
		child.kill(signal);
	}
};

export const startAgentRun = (options: AgentRunOptions, spawnChild: SpawnChild = spawn): RunningAgent => {
	const args = [
		"--mode", "json",
		"--print",
		"--no-session",
		"--no-extensions",
		"--extension", fileURLToPath(new URL("../pi-codex-conversion/index.ts", import.meta.url)),
		"--extension", fileURLToPath(new URL("../bg-bash/index.ts", import.meta.url)),
		"--thinking", options.thinking,
	];
	if (options.model) args.push("--model", options.model);
	args.push(`Task: ${options.task}`);

	const invocation = getPiInvocation(args);
	debug("spawn", { command: invocation.command, args: invocation.args, cwd: options.cwd });
	const child = spawnChild(invocation.command, invocation.args, {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		env: process.env,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const startedAt = Date.now();
	const state: AgentRunSnapshot = {
		...options,
		pid: child.pid ?? -1,
		status: "running",
		exitCode: null,
		startedAt,
		endedAt: null,
		lastActivityAt: startedAt,
		activity: "started",
		completedToolCount: 0,
		output: "",
		stderr: "",
		protocolDiagnostics: "",
		usage: emptyUsage(),
	};
	const snapshot = (): AgentRunSnapshot => ({ ...state, usage: { ...state.usage } });
	let stdoutBuffer = "";
	let requestedTermination: "killed" | undefined;
	let finalized = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let finalizationTimer: ReturnType<typeof setTimeout> | undefined;
	let resolveCompletion!: (result: AgentRunSnapshot) => void;
	const completion = new Promise<AgentRunSnapshot>((resolve) => { resolveCompletion = resolve; });

	const recordActivity = (activity: AgentActivity) => {
		state.lastActivityAt = Date.now();
		state.activity = activity;
	};
	const recordProtocolDiagnostic = (line: string) => {
		state.protocolDiagnostics = appendCapped(state.protocolDiagnostics, `${line}\n`, MAX_DIAGNOSTIC_CHARS);
	};
	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			recordProtocolDiagnostic(line);
			return;
		}
		if (!event || typeof event !== "object" || typeof event.type !== "string") {
			recordProtocolDiagnostic(line);
			return;
		}

		switch (event.type) {
			case "turn_start":
				recordActivity("turn_start");
				state.currentTool = undefined;
				return;
			case "message_update":
				recordActivity("message_update");
				return;
			case "tool_execution_start":
				recordActivity("tool_execution_start");
				state.currentTool = typeof event.toolName === "string" ? event.toolName : undefined;
				return;
			case "tool_execution_end":
				recordActivity("tool_execution_end");
				state.currentTool = undefined;
				state.completedToolCount++;
				return;
			case "message_end": {
				if (event.message?.role !== "assistant") return;
				recordActivity("message_end");
				state.currentTool = undefined;
				const message = event.message;
				const text = textFromAssistant(message);
				if (text) state.output = appendCapped(state.output, `${state.output ? "\n\n" : ""}${text}`, MAX_CAPTURE_CHARS);
				state.usage.turns++;
				state.usage.input += message.usage?.input ?? 0;
				state.usage.output += message.usage?.output ?? 0;
				state.usage.cacheRead += message.usage?.cacheRead ?? 0;
				state.usage.cacheWrite += message.usage?.cacheWrite ?? 0;
				state.usage.cost += message.usage?.cost?.total ?? 0;
				if (!state.model && typeof message.model === "string") state.model = message.model;
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					state.error = message.errorMessage ?? `Subagent stopped: ${message.stopReason}`;
				}
				return;
			}
		}
	};

	child.stdout?.on("data", (data: Buffer) => {
		stdoutBuffer += data.toString();
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
	});
	child.stderr?.on("data", (data: Buffer) => {
		state.stderr = appendCapped(state.stderr, data.toString(), MAX_DIAGNOSTIC_CHARS);
	});

	const clearTimers = () => {
		if (killTimer) clearTimeout(killTimer);
		if (finalizationTimer) clearTimeout(finalizationTimer);
	};
	const finalize = (code: number | null, error?: Error) => {
		if (finalized) return;
		finalized = true;
		clearTimers();
		if (stdoutBuffer.trim()) processLine(stdoutBuffer);
		state.exitCode = code;
		state.endedAt = Date.now();
		state.error = error?.message ?? state.error;
		state.reason = requestedTermination;
		state.status = requestedTermination ?? (code === 0 && !state.error ? "exited" : "failed");
		debug("complete", { pid: state.pid, status: state.status, exitCode: code, error: state.error, outputChars: state.output.length });
		resolveCompletion(snapshot());
	};
	const terminate = () => {
		if (finalized || requestedTermination) return;
		requestedTermination = "killed";
		debug("killed", { pid: state.pid });
		signalProcess(child, state.pid, "SIGTERM");
		killTimer = setTimeout(() => {
			if (finalized) return;
			signalProcess(child, state.pid, "SIGKILL");
			finalizationTimer = setTimeout(() => {
				if (finalized) return;
				if (!state.error) state.error = "Subagent did not exit after SIGKILL";
				finalize(null);
			}, KILL_FINALIZATION_MS);
		}, KILL_GRACE_MS);
	};
	child.once("error", (error) => finalize(1, error));
	child.once("close", (code) => finalize(code));
	child.unref();

	const kill = async () => {
		if (state.status !== "running") return snapshot();
		terminate();
		return completion;
	};

	return { pid: state.pid, completion, snapshot, kill };
};
