import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxProfile } from "./isolation.ts";

const macTest = process.platform === "darwin" ? test : test.skip;

macTest("sandboxed detached descendants survive termination of the original process group", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-process-")));
	const directories = ["worktree", "home", "tmp", "outbox", "inbox"].map((name) => join(root, name));
	for (const directory of directories) mkdirSync(directory);
	const [worktree, workerHome, workerTmp, outbox, inbox] = directories;
	const node = realpathSync(spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim());
	const profile = join(root, "profile.sb");
	writeFileSync(profile, sandboxProfile({
		worktree, workerHome, workerTmp, outbox, inbox, stateRoot: root,
		coordinatorWorktree: join(root, "coordinator"), gitCommonDir: join(root, "git-common"),
		hostHome: join(root, "host-home"), sourceAgentDir: join(root, "host-home", ".pi", "agent"),
	}));
	const pidFile = join(outbox, "descendant.pid");
	const script = `
		const { spawn } = require('node:child_process');
		const { writeFileSync } = require('node:fs');
		const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'ignore' });
		child.on('spawn', () => writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)));
		setTimeout(() => {}, 10000);
	`;
	const parent = spawn("/usr/bin/sandbox-exec", ["-f", profile, node, "-e", script], {
		detached: true, stdio: ["ignore", "ignore", "pipe"],
		env: { PATH: "/usr/bin:/bin", HOME: workerHome, TMPDIR: workerTmp },
});
	let diagnostics = "";
	parent.stderr!.on("data", (chunk) => { diagnostics += chunk; });
	const exited = new Promise((resolve) => parent.once("close", resolve));
	let descendant: number | undefined;
	try {
		for (let attempt = 0; attempt < 100; attempt++) {
			try { descendant = Number(readFileSync(pidFile, "utf8")); break; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		if (!descendant) throw new Error(`Detached child did not start: ${diagnostics}`);
		process.kill(-parent.pid!, "SIGKILL");
		await exited;
		expect(() => process.kill(descendant!, 0)).not.toThrow();
		const group = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(descendant)], { encoding: "utf8" });
		expect(Number(group.stdout.trim())).toBe(descendant);
		expect(descendant).not.toBe(parent.pid);
	} finally {
		for (const pid of [parent.pid, descendant]) {
			if (!pid) continue;
			try { process.kill(-pid, "SIGKILL"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		}
		await exited;
		rmSync(root, { recursive: true, force: true });
	}
}, 5000);
