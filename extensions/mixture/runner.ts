import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPiInvocation } from "../subagent/runner.ts";
import { writeSandboxProfile } from "../agent-swarm/isolation.ts";
import { readJson } from "../agent-swarm/state.ts";

export interface WorkerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface RunOptions {
	task: string;
	models: string[];
	timeoutMs: number;
	thinking: string;
	cwd: string;
}

export const stateHome = () =>
	process.env.PI_MIXTURE_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi", "mixture");

// getPiInvocation follows the current script, which under `bun test` is the test
// file itself. Prefer the real pi binary so workers launch outside test runs too.
export const piCommand = () => {
	const found = spawnSync("/usr/bin/which", ["pi"], { encoding: "utf8" });
	if (found.status === 0 && found.stdout.trim()) return realpathSync(found.stdout.trim());
	return getPiInvocation([]).command;
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
	writeFileSync(join(dir, "settings.json"), JSON.stringify({
		packages: [], extensions: [], skills: [],
		compaction: { enabled: true, reserveTokens: 60000 },
	}));
	writeFileSync(join(dir, "pi-codex-conversion.json"), JSON.stringify({
		executionMode: "normal", voiceFeaturesOnly: true,
		tools: { applyPatchOnly: false, viewImageOnly: false, autoReasoning: false },
		compaction: { contextManagement: "off", hybridCompaction: false, responsesCompaction: false },
		scope: { allProviders: "on" },
	}));
};

export const prepareWorker = (
	model: string,
	options: RunOptions,
	paths: { cwd: string; branch?: string; gitRoot?: string; gitCommonDir?: string },
	run: { id: string; home: string },
) => {
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
	const invocation = {
		command: piCommand(),
		conversion: fileURLToPath(new URL("../pi-codex-conversion/index.ts", import.meta.url)),
		bgBash: fileURLToPath(new URL("../bg-bash/index.ts", import.meta.url)),
	};
	// Preserve provider credentials and shell configuration inside the filesystem sandbox.
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		HOME: workerHome,
		TMPDIR: workerTmp,
		PI_BG_BASH_TMUX_SOCKET: join(workerTmp, "bg.sock"),
		PI_CODING_AGENT_DIR: agentDir,
		PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
	};
	environment.XDG_CACHE_HOME = join(workerTmp, "cache");
	environment.PYTHONPYCACHEPREFIX = join(workerTmp, "python-bytecode");
	environment.UV_CACHE_DIR = join(workerTmp, "uv-cache");
	environment.UV_PROJECT_ENVIRONMENT = join(workerTmp, "uv-venv");
	setupPrivateAgentDir(agentDir, [model]);
	return { profile, invocation, environment };
};
