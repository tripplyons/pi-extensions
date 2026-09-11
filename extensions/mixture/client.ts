import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, repositoryInfo } from "../agent-swarm/git.ts";
import { assertMacSandboxAvailable } from "../agent-swarm/isolation.ts";
import { processExists } from "../agent-swarm/ownership.ts";
import { stateHome, type RunOptions } from "./runner.ts";
import { currentAttempt, terminal, newCommandId, newRunId, readRun, runDir, saveRun, writeJson, type Command, type Run } from "./state.ts";

export function wakeSupervisor(id: string) {
	const home = runDir(id);
	const log = openSync(join(home, "supervisor.log"), "a", 0o600);
	try {
		// Wait across an incumbent's idle exit so a command cannot miss both daemons.
		const child = spawn("/usr/bin/lockf", ["-k", "-t", "5", join(home, "supervisor.lock"),
			process.execPath, fileURLToPath(new URL("./supervisor.ts", import.meta.url)), id], {
			detached: true, stdio: ["ignore", log, log], env: process.env,
		});
		child.on("error", (error) => console.error(`Mixture supervisor launch failed: ${error.message}`));
		child.unref();
	} finally { closeSync(log); }
}

export function startRun(options: RunOptions, ownerSession: string): Run {
	assertMacSandboxAvailable();
	if (!options.task.trim()) throw new Error("task is required");
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
	if (!options.models.length) throw new Error("At least one model is required");
	const repo = repositoryInfo(options.cwd);
	const id = newRunId();
	const home = runDir(id);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const run: Run = {
		schemaVersion: 1, id, ownerSession, createdAt: Date.now(), updatedAt: Date.now(), supervisorPid: 0,
		options, workers: [], commands: [],
	};
	try {
		for (const [slot, model] of options.models.entries()) {
			const workerId = `slot-${slot}`;
			const branch = `pi-mixture/${id}/${workerId}`;
			const cwd = join(home, "worktrees", workerId);
			git(repo.root, ["worktree", "add", "-b", branch, cwd, "HEAD"]);
			run.workers.push({ id: workerId, model, branch, cwd: realpathSync(cwd), gitRoot: repo.root, gitCommonDir: repo.commonDir, attempts: [] });
		}
	} catch (error) {
		for (const worker of run.workers) {
			git(repo.root, ["worktree", "remove", worker.cwd], true);
			git(repo.root, ["branch", "-D", worker.branch!], true);
		}
		throw error;
	}
	saveRun(run);
	wakeSupervisor(id);
	return run;
}

export function commandRun(id: string, session: string, action: Command["action"], workerId?: string, message?: string) {
	const run = readRun(id);
	if (action !== "resume" && run.ownerSession !== session) throw new Error("Run belongs to another session; explicitly resume it first");
	const command: Command = { id: newCommandId(), session, action, workerId, message, createdAt: Date.now() };
	writeJson(join(runDir(id), "commands", `${command.id}.json`), command);
	wakeSupervisor(id);
	return { runId: id, requestId: command.id, status: "pending", message: "Command queued. Inspect the run for acknowledgement; do not repeat it." };
}

export function sessionRuns(session: string) {
	let ids: string[];
	try { ids = readdirSync(join(stateHome(), "runs")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	return ids.filter((id) => /^mix_[a-zA-Z0-9_]+$/.test(id)).flatMap((id) => {
		try { const run = readRun(id); return run.ownerSession === session ? [run] : []; }
		catch { return []; }
	});
}

export function reconnectRuns(session: string) {
	for (const run of sessionRuns(session)) {
		if (run.supervisorPid && processExists(run.supervisorPid)) continue;
		const unfinished = run.workers.some((worker) => !currentAttempt(worker) || !terminal(currentAttempt(worker).status));
		let queued = false;
		try {
			queued = readdirSync(join(runDir(run.id), "commands")).some((name) =>
				/^cmd_[a-f0-9]+\.json$/.test(name) && !run.commands.some((command) => `${command.id}.json` === name));
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (unfinished || queued) wakeSupervisor(run.id);
	}
}
