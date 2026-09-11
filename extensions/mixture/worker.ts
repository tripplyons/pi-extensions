import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Attempt, CommandResult, Status } from "./state.ts";

export interface WorkerLaunch {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	task: string;
	timeoutMs: number;
}

// The supervisor owns the pipes and timeout, never the calling Pi session.
export function launchWorker(config: WorkerLaunch, attempt: Attempt, save: () => void, done: () => void) {
	mkdirSync(dirname(attempt.logFile), { recursive: true, mode: 0o700 });
	const child: ChildProcess = spawn(config.command, config.args, {
		cwd: config.cwd, env: config.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
	});
	const pending = new Map<string, CommandResult>();
	const queued: CommandResult[] = [];
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let stderr = "";
	let ending: Status | undefined;
	let closed = false;
	let settled = false;
	let turnStarted = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let statsTimer: ReturnType<typeof setTimeout> | undefined;
	const signal = (name: NodeJS.Signals) => {
		if (!child.pid) return;
		try { process.kill(-child.pid, name); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	};
	const send = (value: unknown) => child.stdin!.write(`${JSON.stringify(value)}\n`);
	const stop = (status: Status = "stopped") => {
		if (ending || closed) return;
		ending = status;
		attempt.status = "stopping";
		clearTimeout(timeout);
		clearTimeout(statsTimer);
		signal("SIGTERM");
		killTimer = setTimeout(() => signal("SIGKILL"), 1000);
		save();
	};
	const finish = () => {
		if (closed) return;
		closed = true;
		clearTimeout(timeout);
		clearTimeout(killTimer);
		clearTimeout(statsTimer);
		signal("SIGKILL");
		child.stdin?.destroy();
		attempt.status = ending ?? "failed";
		attempt.finishedAt = Date.now();
		if (!ending) attempt.error ??= `Worker exited before settling${stderr ? `: ${stderr}` : ""}`;
		for (const command of pending.values()) {
			command.status = "rejected";
			command.error = "Worker exited before acknowledging the message";
		}
		pending.clear();
		save();
		done();
	};
	const addUsage = (usage: any) => {
		if (!usage) return;
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) attempt.usage[key] += usage[key] ?? 0;
		attempt.usage.cost += usage.cost?.total ?? 0;
	};
	const event = (value: any) => {
		if (value.type === "turn_start") {
			turnStarted = true;
			for (const command of queued.splice(0)) {
				send({ id: command.id, type: "prompt", message: command.message, streamingBehavior: "steer" });
			}
		}
		if (value.type === "response") {
			const command = pending.get(value.id);
			if (command) {
				command.status = value.success ? "accepted" : "rejected";
				if (!value.success) command.error = value.error;
				pending.delete(value.id);
			}
			if (value.id === "initial" && !value.success) {
				attempt.error = value.error;
				stop("failed");
			}
			if (value.id === "final-stats") {
				if (value.success) {
					const stats = value.data;
					for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) attempt.usage[key] = stats.tokens[key];
					attempt.usage.cost = stats.cost;
					attempt.usage.turns = stats.assistantMessages;
				}
				stop(attempt.error ? "failed" : "ok");
			}
		}
		if (value.type === "message_end") {
			const message = value.message;
			addUsage(message.usage);
			if (message.role === "assistant") {
				attempt.usage.turns++;
				const text = message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
				if (text) attempt.output += `${attempt.output ? "\n\n" : ""}${text}`;
				// A later successful retry replaces the earlier provider error.
				attempt.error = ["error", "aborted"].includes(message.stopReason) ? message.errorMessage ?? message.stopReason : undefined;
			}
		}
		if (value.type === "compaction_end") addUsage(value.result?.usage);
		if (value.type === "agent_settled" && turnStarted && !ending && !settled) {
			settled = true;
			send({ id: "final-stats", type: "get_session_stats" });
			statsTimer = setTimeout(() => stop(attempt.error ? "failed" : "ok"), 2000);
		}
		if (value.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(value.method)) {
			send({ type: "extension_ui_response", id: value.id, cancelled: true });
		}
		if (["response", "message_end", "compaction_end", "agent_settled"].includes(value.type)) save();
	};
	const timeout = setTimeout(() => {
		attempt.error = `Worker exceeded ${config.timeoutMs}ms`;
		stop("timeout");
	}, config.timeoutMs);
	child.once("spawn", () => {
		attempt.pid = child.pid;
		attempt.status = "running";
		send({ id: "initial", type: "prompt", message: config.task });
		save();
	});
	child.stdout!.on("data", (chunk: Buffer) => {
		appendFileSync(attempt.logFile, chunk, { mode: 0o600 });
		buffer += decoder.write(chunk);
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let value: unknown;
			try { value = JSON.parse(line); } catch { continue; }
			event(value);
		}
	});
	child.stderr!.on("data", (chunk: Buffer) => {
		appendFileSync(`${attempt.logFile}.stderr`, chunk, { mode: 0o600 });
		stderr = `${stderr}${chunk}`.slice(-4000);
	});
	child.stdin!.on("error", (error) => { attempt.error = error.message; stop("failed"); });
	child.once("error", (error) => { attempt.error = error.message; finish(); });
	// Kill descendants on exit so inherited pipes cannot prevent close.
	child.once("exit", () => signal("SIGKILL"));
	child.once("close", finish);
	return {
		stop,
		send(command: CommandResult) {
			if (ending || closed || settled) throw new Error("Worker is no longer accepting messages");
			pending.set(command.id, command);
			// Concurrent prompts during initial startup can settle before its first turn.
			if (!turnStarted) { queued.push(command); return; }
			send({ id: command.id, type: "prompt", message: command.message, streamingBehavior: "steer" });
		},
	};
}
