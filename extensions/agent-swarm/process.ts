import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { complaintLogPath } from "../complain/index.ts";
import { assertMacSandboxAvailable, sandboxProfile, workerEnvironment } from "./isolation.ts";
import { provisionMixtureWorker } from "./mixture-worker.ts";
import { processExists } from "./ownership.ts";
import { ensureDir, inboxDir, outboxDir, readJson, runDir, stateRoot, tokenFile, updateNode, workerHome, workerTmp, writeJson } from "./state.ts";
import { sessionExists, tmux, windowExists } from "./tmux.ts";
import { WORKER_ENV, workerTimeoutFor, type NodeRecord } from "./types.ts";
import type { WorkerProcesses } from "./runtime.ts";

interface ProcessStatus {
	pid: number | null;
	supervisorPid: number;
	status: string;
	failure: string | null;
}
const controlDirectory = (node: NodeRecord) => join(runDir(node.runId), "control", "processes", node.nodeId);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const executable = (name: string) => {
	const result = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Required executable unavailable: ${name}`);
	return realpathSync(result.stdout.trim());
};
export const inheritedFastEnvironment = (enabled: boolean | undefined) => enabled ? "1" : "0";

export const workerPath = (executables: string[], inheritedPath = process.env.PATH ?? "") => [...new Set([
	...executables.map(dirname),
	...inheritedPath.split(":").filter(isAbsolute),
	"/usr/bin", "/bin", "/usr/sbin", "/sbin",
])].join(":");

export function workerExtensionArguments(entryPoint: string, includeMixture: boolean): string[] {
	const conversion = fileURLToPath(new URL("../pi-codex-conversion/index.ts", import.meta.url));
	const bgBash = fileURLToPath(new URL("../bg-bash/index.ts", import.meta.url));
	const swarm = realpathSync(entryPoint);
	const complain = realpathSync(fileURLToPath(new URL("../complain/index.ts", import.meta.url)));
	const mixture = includeMixture ? realpathSync(fileURLToPath(new URL("../mixture/index.ts", import.meta.url))) : undefined;
	return ["--extension", conversion, "--extension", bgBash, "--extension", swarm, ...(mixture ? ["--extension", mixture] : []), "--extension", complain];
}

export interface WorkerProcessDependencies {
	assertSandboxAvailable?: () => void;
	findExecutable?: (name: string) => string;
	tmux?: (args: string[], allowFailure?: boolean) => unknown;
	sessionExists?: (session: string) => boolean;
	windowExists?: (session: string, window: string) => boolean;
}

export function createWorkerProcesses(entryPoint: string, dependencies: WorkerProcessDependencies = {}): WorkerProcesses {
	const checkSandbox = dependencies.assertSandboxAvailable ?? assertMacSandboxAvailable;
	const findExecutable = dependencies.findExecutable ?? executable;
	const runTmux = dependencies.tmux ?? tmux;
	const hasSession = dependencies.sessionExists ?? sessionExists;
	const hasWindow = dependencies.windowExists ?? windowExists;
	const status = (node: NodeRecord) => readJson<ProcessStatus>(join(controlDirectory(node), "status.json"));
	return {
		status(node) {
			const current = status(node);
			if (current && !processExists(current.supervisorPid) && !["exited", "failed", "timed-out"].includes(current.status)) return { ...current, status: "failed", failure: "Worker supervisor disappeared" };
			return current;
		},
		async start(run, node) {
			checkSandbox();
			if (!node.model) throw new Error("Worker model must be inherited from the root session");
			if (status(node) && processExists(status(node)!.supervisorPid)) throw new Error("Worker supervisor is already alive");
			const nodeExecutable = findExecutable("node");
			let gitExecutable = findExecutable("git");
			if (gitExecutable === "/usr/bin/git") {
				const selected = spawnSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8" });
				if (selected.status !== 0) throw new Error("Cannot resolve the Git executable behind the Xcode shim");
				gitExecutable = realpathSync(selected.stdout.trim());
			}
			const pi = findExecutable("pi");
			const tmuxExecutable = findExecutable("tmux");
			const privateHome = workerHome(run.runId, node.nodeId);
			const agentDir = join(privateHome, ".pi", "agent");
			ensureDir(agentDir);
			const sourceAgent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
			const mixture = provisionMixtureWorker(node.model, sourceAgent, agentDir);
			if (!mixture) {
				const provider = node.model.split("/")[0];
				const credentials = readJson<Record<string, unknown>>(join(sourceAgent, "auth.json"));
				if (!credentials?.[provider]) throw new Error(`No stored ${provider} credential available for the private worker home`);
				writeJson(join(agentDir, "auth.json"), { [provider]: credentials[provider] });
			}
			writeJson(join(agentDir, "settings.json"), { packages: [], extensions: [], skills: [], compaction: { enabled: true, reserveTokens: 60000 } });
			writeJson(join(agentDir, "pi-codex-conversion.json"), {
				executionMode: "normal", voiceFeaturesOnly: true,
				tools: { applyPatchOnly: false, viewImageOnly: false, autoReasoning: false },
				compaction: { contextManagement: "off", hybridCompaction: false, responsesCompaction: false },
				scope: { allProviders: "on" },
			});
			const control = controlDirectory(node);
			ensureDir(control);
			rmSync(join(control, "status.json"), { force: true });
			writeJson(join(control, "command.json"), { status: run.status === "paused" ? "paused" : "running" });
			const profile = join(control, "profile.sb");
			const paths = {
				worktree: node.cwd, workerHome: privateHome, workerTmp: workerTmp(run.runId, node.nodeId),
				outbox: outboxDir(run.runId, node.nodeId), inbox: inboxDir(run.runId, node.nodeId),
				stateRoot: stateRoot(), coordinatorWorktree: run.gitRoot, gitCommonDir: run.gitCommonDir,
				hostHome: homedir(), sourceAgentDir: sourceAgent,
				readOnlyWorktree: node.role === "reviewer",
			};
			writeFileSync(profile, sandboxProfile(paths), { mode: 0o600 });
			const environment = workerEnvironment({
				HOME: privateHome, TMPDIR: paths.workerTmp, PI_CODING_AGENT_DIR: agentDir,
				PATH: workerPath([nodeExecutable, gitExecutable, tmuxExecutable]),
				[WORKER_ENV]: "1", PI_SWARM_HOME: stateRoot(), PI_SWARM_RUN: run.runId, PI_SWARM_NODE: node.nodeId,
				PI_COMPLAIN_LOG: complaintLogPath(),
				PI_SWARM_FAST: inheritedFastEnvironment(run.config.fastMode),
				PI_SWARM_TOKEN: readFileSync(tokenFile(run.runId, node.nodeId), "utf8"),
			});
			const args = [pi, "--mode", "json", "--print", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
				...workerExtensionArguments(entryPoint, !!mixture), "--model", node.model, "--thinking", node.thinking ?? "medium",
				"--session-dir", join(agentDir, "sessions"), "Read swarm_task for your assignment. Work within your role and submit through swarm_complete."];
			const config = join(control, "launch.json");
			writeJson(config, { profile, executable: nodeExecutable, args, cwd: node.cwd, environment, timeoutMs: workerTimeoutFor(run, node), statusFile: join(control, "status.json"), commandFile: join(control, "command.json") });
			const window = node.nodeId.slice(-12);
			const command = [nodeExecutable, fileURLToPath(new URL("./supervisor.mjs", import.meta.url)), config].map(shellQuote).join(" ");
			if (!hasSession(run.tmuxSession)) runTmux(["new-session", "-d", "-s", run.tmuxSession, "-n", window, command]);
			else if (hasWindow(run.tmuxSession, window)) runTmux(["respawn-pane", "-k", "-t", `${run.tmuxSession}:${window}`, command]);
			else runTmux(["new-window", "-d", "-t", run.tmuxSession, "-n", window, command]);
			runTmux(["set-option", "-w", "-t", `${run.tmuxSession}:${window}`, "remain-on-exit", "on"]);
			updateNode(run.runId, node.nodeId, (current) => {
				current.tmuxSession = run.tmuxSession; current.tmuxWindow = window;
				current.sandbox = { backend: "macos-sandbox-exec", profile, readOnlyWorktree: node.role === "reviewer", network: "tcp-udp-outbound", lifecycle: "process-group" };
			});
		},
		async set(node, desired) {
			const current = status(node);
			if (!current || !processExists(current.supervisorPid)) {
				if (desired === "stopped") return;
				throw new Error(`Worker supervisor is unavailable: ${node.nodeId}`);
			}
			writeJson(join(controlDirectory(node), "command.json"), { status: desired });
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const observed = status(node);
				if (desired === "stopped" ? !processExists(current.supervisorPid) : observed?.status === desired) return;
				if (desired !== "stopped" && observed && ["failed", "exited", "timed-out"].includes(observed.status)) throw new Error(`Worker ${observed.status}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error(`Worker did not acknowledge ${desired}: ${node.nodeId}`);
		},
	};
}
