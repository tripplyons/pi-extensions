import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxProfile } from "./isolation.ts";
import { processExists } from "./ownership.ts";
import { readJson, writeJson } from "./state.ts";

const macTest = process.platform === "darwin" ? test : test.skip;
const waitFor = async (condition: () => boolean) => {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("Supervisor fixture did not reach the expected state");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};

macTest("supervisor pauses group execution and enforces timeout after controller death", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-supervisor-")));
	const [worktree, workerHome, workerTmp, outbox, inbox] = ["worktree", "home", "tmp", "outbox", "inbox"].map((name) => join(root, name));
	for (const path of [worktree, workerHome, workerTmp, outbox, inbox]) mkdirSync(path);
	const node = realpathSync(spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim());
	const profile = join(root, "profile.sb");
	writeFileSync(profile, sandboxProfile({
		worktree, workerHome, workerTmp, outbox, inbox, stateRoot: root,
		coordinatorWorktree: join(root, "coordinator"), gitCommonDir: join(root, "git-common"),
		hostHome: join(root, "host-home"), sourceAgentDir: join(root, "host-home", ".pi", "agent"),
	}));
	const statusFile = join(root, "status.json");
	const commandFile = join(root, "command.json");
	const activityFile = join(worktree, "activity");
	const configFile = join(root, "launch.json");
	writeJson(configFile, {
		profile, executable: node, cwd: worktree, timeoutMs: 1000, statusFile, commandFile,
		environment: { HOME: workerHome, TMPDIR: workerTmp, PATH: "/usr/bin:/bin" },
		args: ["-e", `process.on('SIGTERM', () => {}); setInterval(() => require('node:fs').writeFileSync(${JSON.stringify(activityFile)}, String(Date.now())), 25);`],
	});
	const supervisor = fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
	const controller = spawn(node, ["-e", `
		const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(supervisor)}, ${JSON.stringify(configFile)}], { detached:true, stdio:'ignore' });
		child.unref(); setTimeout(() => {}, 10000);
	`], { stdio: "ignore" });
	const controllerExited = new Promise<void>((resolve) => controller.once("close", () => resolve()));
	const status = () => readJson<{ pid: number; supervisorPid: number; status: string }>(statusFile);
	let workerPid: number | undefined;
	let supervisorPid: number | undefined;
	try {
		await waitFor(() => status()?.status === "running" && existsSync(activityFile));
		workerPid = status()!.pid;
		supervisorPid = status()!.supervisorPid;
		writeJson(commandFile, { status: "paused" });
		await waitFor(() => status()?.status === "paused");
		const pausedContent = readFileSync(activityFile, "utf8");
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(readFileSync(activityFile, "utf8")).toBe(pausedContent);
		expect(status()!.status).toBe("paused");
		writeJson(commandFile, { status: "running" });
		await waitFor(() => status()?.status === "running");
		controller.kill("SIGKILL");
		await controllerExited;
		await waitFor(() => !processExists(workerPid!));
		expect(status()!.status).toBe("timed-out");
		await waitFor(() => !processExists(supervisorPid!));
	} finally {
		controller.kill("SIGKILL");
		await controllerExited;
		for (const pid of [workerPid ? -workerPid : undefined, supervisorPid]) {
			if (!pid) continue;
			try { process.kill(pid, "SIGKILL"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 12000);
