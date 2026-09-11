import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPiInvocation } from "../subagent/runner.ts";
import { git, repositoryInfo } from "../agent-swarm/git.ts";
import { assertMacSandboxAvailable, writeSandboxProfile } from "../agent-swarm/isolation.ts";
import { readJson } from "../agent-swarm/state.ts";

export type WorkerStatus = "ok" | "failed" | "timeout";

export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface WorkerResult {
	model: string;
	status: WorkerStatus;
	output: string;
	error?: string;
	usage: WorkerUsage;
	branch?: string;
	worktree?: string;
	diffStat?: string;
}

export interface RunOptions {
	task: string;
	models: string[];
	timeoutMs: number;
	thinking: string;
	cwd: string;
}

export type SpawnChild = typeof spawn;

interface RunDeps {
	spawnChild?: SpawnChild;
	runId?: string;
}

const KILL_GRACE_MS = 2_000;

export const stateHome = () =>
	process.env.PI_MIXTURE_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi", "mixture");

// getPiInvocation follows the current script, which under `bun test` is the test
// file itself. Prefer the real pi binary so workers launch outside test runs too.
const piCommand = () => {
	const found = spawnSync("/usr/bin/which", ["pi"], { encoding: "utf8" });
	if (found.status === 0 && found.stdout.trim()) return realpathSync(found.stdout.trim());
	return getPiInvocation([]).command;
};

const emptyUsage = (): WorkerUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });

const textFromAssistant = (message: any) => {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
};

export const workerArgs = (model: string, thinking: string, task: string) => {
	const conversion = realpathSync(fileURLToPath(import.meta.resolve("@howaboua/pi-codex-conversion")));
	return [
		"--mode", "json",
		"--print",
		"--no-session",
		"--no-extensions",
		"--extension", conversion,
		"--thinking", thinking,
		"--model", model,
		`Task: ${task}`,
	];
};

const agentSourceDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const setupPrivateAgentDir = (dir: string, models: string[]) => {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const credentials = readJson<Record<string, unknown>>(join(agentSourceDir(), "auth.json"));
	const subset: Record<string, unknown> = {};
	for (const provider of new Set(models.map((model) => model.split("/")[0]))) {
		if (credentials?.[provider]) subset[provider] = credentials[provider];
	}
	if (Object.keys(subset).length) writeFileSync(join(dir, "auth.json"), JSON.stringify(subset), { mode: 0o600 });
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [], extensions: [], skills: [] }));
	writeFileSync(join(dir, "pi-codex-conversion.json"), JSON.stringify({ executionMode: "code", scope: { allProviders: "on" } }));
};

const removeWorktree = (gitRoot: string, branch: string, path: string) => {
	git(gitRoot, ["worktree", "remove", "--force", path], true);
	git(gitRoot, ["branch", "-D", branch], true);
};

const runWorker = (
	model: string,
	options: RunOptions,
	paths: { cwd: string; branch?: string; gitRoot?: string; gitCommonDir?: string },
	run: { id: string; home: string },
	spawnChild: SpawnChild,
): Promise<WorkerResult> => {
	const workerBase = join(run.home, `worker-${basename(paths.cwd).replace(/[^a-zA-Z0-9_-]/g, "_")}-${model.split("/").at(-1)}`);
	const workerHome = join(workerBase, "home");
	const workerTmp = join(workerBase, "tmp");
	const outbox = join(workerBase, "outbox");
	const inbox = join(workerBase, "inbox");
	// The agent dir must live under the sandbox-writable worker home: pi takes
	// a lock next to trust.json on startup and the profile denies writes to
	// every other path under the state root.
	const agentDir = join(workerHome, ".pi", "agent");
	for (const dir of [workerHome, workerTmp, outbox, inbox, agentDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const profile = join(workerBase, "profile.sb");
	const sourceAgent = agentSourceDir();
	writeSandboxProfile(profile, {
		worktree: paths.cwd,
		workerHome,
		workerTmp,
		outbox,
		inbox,
		stateRoot: stateHome(),
		coordinatorWorktree: paths.gitRoot ?? options.cwd,
		gitCommonDir: paths.gitCommonDir ?? join(options.cwd, ".git"),
		hostHome: homedir(),
		sourceAgentDir: sourceAgent,
	});
	const invocation = { command: piCommand(), args: workerArgs(model, options.thinking, options.task) };
	// One-shot `pi --print` children inherit the full parent environment like
	// subagent children do. A minimal allowlist env hangs the child after
	// agent_settled: something in the normal shell environment is required for
	// the code-mode host to shut down. Filesystem isolation still comes from
	// the sandbox profile; only the identity dirs below are overridden.
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		HOME: workerHome,
		TMPDIR: workerTmp,
		PI_CODING_AGENT_DIR: agentDir,
		PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
	};
	environment.XDG_CACHE_HOME ??= join(workerTmp, "cache");
	environment.PYTHONPYCACHEPREFIX ??= join(workerTmp, "python-bytecode");
	environment.UV_CACHE_DIR ??= join(workerTmp, "uv-cache");
	environment.UV_PROJECT_ENVIRONMENT ??= join(workerTmp, "uv-venv");
	setupPrivateAgentDir(agentDir, options.models);
	const result: WorkerResult = { model, status: "failed", output: "", usage: emptyUsage(), branch: paths.branch, worktree: paths.cwd };
	return new Promise((resolve) => {
		let settled = false;
		let stdoutBuffer = "";
		let stderrTail = "";
		const finish = (status: WorkerStatus, error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			result.status = status;
			if (error) result.error = error;
			if (paths.branch && paths.gitRoot) {
				const stat = git(paths.cwd, ["diff", "--stat", "HEAD", "--", "."], true);
				if (stat.ok && stat.stdout.trim()) result.diffStat = stat.stdout.trim();
			}
			resolve(result);
		};
		const child = spawnChild("/usr/bin/sandbox-exec", ["-f", profile, invocation.command, ...invocation.args], {
			cwd: paths.cwd,
			detached: process.platform !== "win32",
			env: environment,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		} as any) as ChildProcess;
		const killGroup = (signal: NodeJS.Signals) => {
			const pid = child.pid;
			if (pid === undefined) return;
			try {
				if (process.platform === "win32") child.kill(signal);
				else process.kill(-pid, signal);
			} catch {
				try { child.kill(signal); } catch { /* already gone */ }
			}
		};
		const timer = setTimeout(() => {
			killGroup("SIGTERM");
			setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref?.();
			finish("timeout", `Worker exceeded ${options.timeoutMs}ms`);
		}, options.timeoutMs);
		timer.unref?.();
		const settle = () => {
			if (result.error) finish("failed", result.error);
			else finish("ok");
			killGroup("SIGTERM");
		};
		child.stdout?.on("data", (data: Buffer) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (event?.type === "agent_settled" || event?.type === "agent_end") {
					settle();
					continue;
				}
				if (event?.type !== "message_end" || event.message?.role !== "assistant") continue;
				const text = textFromAssistant(event.message);
				if (text) result.output += `${result.output ? "\n\n" : ""}${text}`;
				result.usage.turns++;
				result.usage.input += event.message.usage?.input ?? 0;
				result.usage.output += event.message.usage?.output ?? 0;
				result.usage.cacheRead += event.message.usage?.cacheRead ?? 0;
				result.usage.cacheWrite += event.message.usage?.cacheWrite ?? 0;
				result.usage.cost += event.message.usage?.cost?.total ?? 0;
				if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
					result.error = event.message.errorMessage ?? `Worker stopped: ${event.message.stopReason}`;
				}
			}
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderrTail = `${stderrTail}${data.toString()}`.slice(-2000);
		});
		child.on("error", (error) => finish("failed", error.message));
		child.on("close", (code) => {
			if (code === 0 && !result.error) finish("ok");
			else finish("failed", [result.error ?? `Worker exited ${code}`, stderrTail.trim()].filter(Boolean).join("\nstderr: "));
		});
	});
};

export const runMixture = async (options: RunOptions, deps: RunDeps = {}): Promise<WorkerResult[]> => {
	assertMacSandboxAvailable();
	const spawnChild = deps.spawnChild ?? spawn;
	const runId = deps.runId ?? `mix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const home = join(stateHome(), "runs", runId);
	mkdirSync(home, { recursive: true, mode: 0o700 });

	let repo: { root: string; commonDir: string } | null = null;
	try {
		const info = repositoryInfo(options.cwd);
		repo = { root: info.root, commonDir: info.commonDir };
	} catch {
		repo = null;
	}

	const assignments = options.models.map((model, slot) => {
		if (!repo) return { model, cwd: options.cwd };
		const branch = `pi-mixture/${runId}/slot-${slot}`;
		const path = join(home, "worktrees", `slot-${slot}`);
		git(repo.root, ["worktree", "add", "-b", branch, path, "HEAD"]);
		return { model, cwd: realpathSync(path), branch, gitRoot: repo.root, gitCommonDir: repo.commonDir };
	});

	try {
		const run = { id: runId, home };
		return await Promise.all(assignments.map((assignment) => runWorker(assignment.model, options, assignment, run, spawnChild)));
	} finally {
		for (const assignment of assignments) {
			if (!("branch" in assignment) || !existsSync(assignment.cwd)) continue;
			const dirty = git(assignment.cwd, ["status", "--porcelain"], true);
			if (dirty.ok && !dirty.stdout.trim()) removeWorktree(assignment.gitRoot!, assignment.branch!, assignment.cwd);
		}
	}
};
