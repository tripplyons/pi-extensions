import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireRunOwnership } from "./ownership.ts";
import { readRun, runFile, writeJson } from "./state.ts";
import { defaultConfig, SCHEMA_VERSION, type RunRecord } from "./types.ts";

const macTest = process.platform === "darwin" ? test : test.skip;

macTest("kernel ownership lock rejects a second root and permits clean reacquisition", async () => {
	const previousHome = process.env.PI_SWARM_HOME;
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-owner-"));
	process.env.PI_SWARM_HOME = root;
	const run: RunRecord = {
		schemaVersion: SCHEMA_VERSION, runId: "run_test", rootNodeId: "node_root", rootSessionId: "test",
		ownerToken: "unowned", ownerPid: 0, heartbeatAt: 0, cwd: root, gitRoot: root, gitCommonDir: root,
		createdAt: 1, updatedAt: 1, status: "active", config: defaultConfig, tmuxSession: "test",
	};
	let owner: Awaited<ReturnType<typeof acquireRunOwnership>> | undefined;
	try {
		writeJson(runFile(run.runId), run);
		owner = await acquireRunOwnership(run.runId);
		expect(owner.assertOwned().ownerPid).toBe(process.pid);
		await expect(acquireRunOwnership(run.runId)).rejects.toThrow("ownership unavailable");
		owner.heartbeat();
		expect(readRun(run.runId).heartbeatAt).toBeGreaterThan(1);
		const first = owner;
		await first.release();
		expect(() => first.assertOwned()).toThrow("lost");
		owner = await acquireRunOwnership(run.runId);
		expect(owner.token).not.toBe(first.token);
		await owner.release();
		const child = spawn("node", ["--input-type=module", "-e", `
			import { acquireRunOwnership } from ${JSON.stringify(new URL("./ownership.ts", import.meta.url).href)};
			await acquireRunOwnership('run_test');
			console.log('ready');
			setTimeout(() => process.exit(0), 10000);
		`], { stdio: ["ignore", "pipe", "pipe"] });
		const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
		try {
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("Fixture owner did not start")), 2000);
				child.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
				child.once("error", (error) => { clearTimeout(timeout); reject(error); });
				child.once("close", (code) => { clearTimeout(timeout); reject(new Error(`Fixture owner exited ${code}`)); });
			});
			expect(readRun(run.runId).ownerPid).toBe(child.pid!);
			child.kill("SIGKILL");
			await exited;
			for (let attempt = 0; ; attempt++) {
				try { owner = await acquireRunOwnership(run.runId); break; }
				catch (error) {
					if (attempt >= 50) throw error;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}
			expect(owner.assertOwned().ownerPid).toBe(process.pid);
		} finally { child.kill("SIGKILL"); await exited; }
	} finally {
		await owner?.release();
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
});
