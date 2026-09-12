import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../agent-swarm/git.ts";
import { processExists } from "../agent-swarm/ownership.ts";
import { prepareWorker } from "./runner.ts";
import { currentAttempt, emptyUsage, readJson, readRun, runDir, saveRun, terminal, type Attempt, type Command, type CommandResult, type Worker } from "./state.ts";
import { launchWorker } from "./worker.ts";

export function supervise(id: string) {
	const run = readRun(id);
	const home = runDir(id);
	const commandsDir = join(home, "commands");
	mkdirSync(commandsDir, { recursive: true, mode: 0o700 });
	const active = new Map<string, ReturnType<typeof launchWorker>>();
	const save = () => saveRun(run);
	let stopping = false;
	let idleAt = Date.now();
	run.supervisorPid = process.pid;
	for (const command of run.commands) {
		if (command.status !== "pending") continue;
		command.status = "rejected";
		command.error = "Supervisor disappeared before acknowledgement. Delivery is unknown; inspect the worker session before resending.";
	}
	for (const worker of run.workers) {
		const attempt = currentAttempt(worker);
		if (attempt && !terminal(attempt.status)) {
			attempt.status = "failed";
			attempt.error = "Supervisor disappeared. Inspect the recorded process before restarting.";
			attempt.finishedAt = Date.now();
		}
	}
	save();
	const start = (worker: Worker) => {
		const previous = currentAttempt(worker);
		if (previous && !terminal(previous.status)) throw new Error("Worker is still running");
		if (previous?.pid && processExists(previous.pid)) throw new Error("Previous worker process still exists");
		const number = worker.attempts.length + 1;
		const base = join(home, worker.id, `attempt-${number}`);
		mkdirSync(base, { recursive: true, mode: 0o700 });
		const attempt: Attempt = {
			attempt: number, status: "queued", startedAt: Date.now(), output: "", usage: emptyUsage(),
			logFile: join(base, "events.jsonl"), sessionFile: "",
		};
		worker.attempts.push(attempt);
		save();
		let prepared: ReturnType<typeof prepareWorker>;
		try { prepared = prepareWorker(worker.model, run.options, worker, { id, home: base }); }
		catch (error) {
			attempt.status = "failed";
			attempt.error = `Worker preparation failed: ${String(error)}`;
			attempt.finishedAt = Date.now();
			writeFileSync(attempt.logFile, JSON.stringify({ type: "preparation_error", error: attempt.error }) + "\n", { mode: 0o600 });
			save();
			throw error;
		}
		const sessionFile = join(prepared.environment.HOME!, "session.jsonl");
		attempt.sessionFile = sessionFile;
		const conversion = prepared.invocation.conversion;
		active.set(worker.id, launchWorker({
			command: "/usr/bin/sandbox-exec",
			args: ["-f", prepared.profile, prepared.invocation.command, "--mode", "rpc", "--session", sessionFile,
				"--no-extensions", "--extension", conversion, "--extension", prepared.invocation.bgBash,
				"--thinking", run.options.thinking, "--model", worker.model],
			cwd: worker.cwd, env: prepared.environment, task: run.options.task, timeoutMs: run.options.timeoutMs,
		}, attempt, save, () => {
			active.delete(worker.id);
			const status = git(worker.cwd, ["status", "--short", "--untracked-files=all"], true);
			worker.changes = status.ok ? status.stdout.trim() : `Unable to inspect worktree: ${status.stderr}`;
			idleAt = Date.now();
			save();
		}));
	};
	const apply = (command: CommandResult) => {
		if (command.action === "resume") {
			run.ownerSession = command.session;
			return;
		}
		if (command.session !== run.ownerSession) throw new Error("Run belongs to another session; explicitly resume it first");
		if (command.action === "stop" && !command.workerId) {
			for (const controller of active.values()) controller.stop();
			return;
		}
		const worker = run.workers.find((worker) => worker.id === command.workerId);
		if (!worker) throw new Error("Unknown worker ID");
		if (command.action === "restart") { start(worker); return; }
		const controller = active.get(worker.id);
		if (!controller) throw new Error("Worker is not running");
		if (command.action === "stop") { controller.stop(); return; }
		if (command.action !== "send" || !command.message?.trim()) throw new Error("A nonempty steering message is required");
		command.status = "pending";
		controller.send(command);
	};
	for (const worker of run.workers) {
		if (!worker.attempts.length) {
			try { start(worker); }
			catch (error) {
				console.error(error);
			}
		}
	}
	const timer = setInterval(() => {
		try {
			const commands = readdirSync(commandsDir)
				.filter((name) => /^cmd_[a-f0-9]+\.json$/.test(name))
				.map((name) => readJson<Command>(join(commandsDir, name))!)
				.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
			for (const command of commands) {
				if (run.commands.some((stored) => stored.id === command.id)) continue;
				const result: CommandResult = { ...command, status: "accepted" };
				run.commands.push(result);
				try {
					if (stopping) throw new Error("Supervisor is stopping");
					apply(result);
				} catch (error) { result.status = "rejected"; result.error = String(error); }
				idleAt = Date.now();
				save();
			}
			if (!active.size && Date.now() - idleAt > 1500) {
				clearInterval(timer);
				run.supervisorPid = 0;
				save();
			}
		} catch (error) {
			console.error(error);
			stopping = true;
			for (const controller of active.values()) controller.stop("failed");
			if (!active.size) clearInterval(timer);
		}
	}, 100);
	const stop = () => { stopping = true; for (const controller of active.values()) controller.stop(); };
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) supervise(process.argv[2]);
