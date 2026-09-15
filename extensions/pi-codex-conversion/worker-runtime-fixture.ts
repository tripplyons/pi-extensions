import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../agent-swarm/git.ts";
import { createWorkerProcesses } from "../agent-swarm/process.ts";
import { SwarmRuntime } from "../agent-swarm/runtime.ts";
import { runDir } from "../agent-swarm/state.ts";
import type { NodeRecord } from "../agent-swarm/types.ts";

// Exercise real provisioning and the worker mailbox; only OS process launch is stubbed.
export async function provisionOfflineWorker(dir: string) {
	const cwd = join(dir, "repository");
	await mkdir(cwd);
	git(cwd, ["init", "-b", "main"]);
	git(cwd, ["config", "user.name", "Offline Worker Fixture"]);
	git(cwd, ["config", "user.email", "fixture@example.invalid"]);
	await writeFile(join(cwd, "fixture.txt"), "checkout-sentinel\n");
	git(cwd, ["add", "fixture.txt"]);
	git(cwd, ["commit", "-m", "Initialize fixture"]);
	const processes = createWorkerProcesses(fileURLToPath(new URL("../agent-swarm/index.ts", import.meta.url)), {
		assertSandboxAvailable() {}, findExecutable: name => `/fixture/bin/${name}`,
		tmux() {}, sessionExists: () => false, windowExists: () => false,
	});
	const runtime = await SwarmRuntime.create({ cwd, sessionId: "offline-fixture", objective: "Exercise worker local context", model: "mixture/fixture", thinking: "high" }, processes);
	try {
		const node = await runtime.act(runtime.root.nodeId, "spawn", { role: "worker", task: "Record private context facts without checkout changes" }) as NodeRecord;
		const launch = JSON.parse(await readFile(join(runDir(runtime.runId), "control", "processes", node.nodeId, "launch.json"), "utf8"));
		let polling = Promise.resolve();
		let failure: unknown;
		const timer = setInterval(() => { polling = polling.then(() => runtime.poll()).catch(error => { failure = error; }); }, 10);
		return {
			cwd: node.cwd, agentDir: launch.environment.PI_CODING_AGENT_DIR as string,
			environment: launch.environment as Record<string, string>,
			extensions: launch.args.flatMap((arg: string, index: number) => arg === "--extension" ? [launch.args[index + 1]] : []) as string[],
			async close() {
				clearInterval(timer);
				await polling;
				try { await runtime.kill(); await runtime.clear(); }
				finally { await runtime.close(); }
				if (failure) throw failure;
			},
		};
	} catch (error) { await runtime.kill(); await runtime.close(); throw error; }
}
