import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_RELEASE } from "@howaboua/pi-codex-conversion/dist/tools/code-mode/host-assets.js";
import { git } from "./git.ts";
import { sandboxProfile } from "./isolation.ts";
import { createWorkerProcesses } from "./process.ts";
import { SwarmRuntime, type WorkerProcesses } from "./runtime.ts";
import { inboxDir, outboxDir, readNode, runDir, tokenFile, workerHome, workerTmp, writeJson } from "./state.ts";
import type { NodeRecord } from "./types.ts";

const macTest = process.platform === "darwin" && process.env.PI_SWARM_TEST_CODE_HOST ? test : test.skip;

macTest("Code mode completion returns before review pause and rework reaches the same Pi worker", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-completion-")));
	const repository = join(directory, "repo");
	const state = join(directory, "state");
	mkdirSync(repository);
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = state;
	git(repository, ["init", "-b", "main"]);
	git(repository, ["config", "user.name", "Swarm Test"]);
	git(repository, ["config", "user.email", "swarm@example.invalid"]);
	writeFileSync(join(repository, "initial"), "base\n");
	git(repository, ["add", "initial"]); git(repository, ["commit", "-m", "Initialize fixture"]);
	const executable = realpathSync(spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim());
	const pi = realpathSync(spawnSync("which", ["pi"], { encoding: "utf8" }).stdout.trim());
	const swarm = fileURLToPath(new URL("./index.ts", import.meta.url));
	const conversion = realpathSync(fileURLToPath(import.meta.resolve("@howaboua/pi-codex-conversion")));
	const supervisorPath = fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
	let supervisor: ChildProcess | undefined;
	let runtime: SwarmRuntime | undefined;
	const processes: WorkerProcesses = {
		...createWorkerProcesses(swarm),
		async start(run, node) {
			const home = workerHome(run.runId, node.nodeId);
			const agent = join(home, ".pi", "agent");
			const host = join(agent, "cache", "pi-codex-conversion", "code-mode", HOST_RELEASE, `${process.platform}-${process.arch}`);
			mkdirSync(host, { recursive: true });
			copyFileSync(process.env.PI_SWARM_TEST_CODE_HOST!, join(host, "codex-code-mode-host"));
			writeJson(join(agent, "settings.json"), { packages: [], extensions: [] });
			writeJson(join(agent, "pi-codex-conversion.json"), { executionMode: "code" });
			const outbox = outboxDir(run.runId, node.nodeId);
			const fixture = join(home, "fixture.ts");
			// Run the installed Code mode host and the real swarm agent_end hook,
			// but intercept delivery instead of making a paid inference request.
			writeFileSync(fixture, `
				import conversion from ${JSON.stringify(conversion)};
				import swarm from ${JSON.stringify(swarm)};
				import { existsSync, writeFileSync } from 'node:fs';
				export default async pi => {
					let exec, end;
					const register = pi.registerTool.bind(pi), on = pi.on.bind(pi);
					pi.registerTool = tool => { if (tool.name === 'exec') exec = tool; register(tool); };
					await conversion(pi);
					pi.on = (name, handler) => { if (name === 'agent_end') end = handler; on(name, handler); };
					await swarm(pi);
					pi.sendUserMessage = text => writeFileSync(${JSON.stringify(join(outbox, "delivery"))}, text);
					on('session_start', async (_event, ctx) => {
						writeFileSync(${JSON.stringify(join(node.cwd, "feature"))}, 'implemented');
						const result = await exec.execute('complete-fixture', {code:'text(await tools.swarm_complete({text:"Done",verification:"offline fixture"}))'}, new AbortController().signal, undefined, ctx);
						writeFileSync(${JSON.stringify(join(outbox, "receipt.json"))}, JSON.stringify(result));
						await end({messages:[]}, ctx);
						writeFileSync(${JSON.stringify(join(outbox, "resumed"))}, 'yes');
						while (!existsSync(${JSON.stringify(join(outbox, "continue"))})) await new Promise(resolve => setTimeout(resolve, 25));
						await exec.execute('unfinished-fixture', {code:'text(await tools.swarm_complete({text:"Revised report"}))'}, new AbortController().signal, undefined, ctx);
						// Deliberately omit agent_end: the supervisor must bound this turn.
						await new Promise(() => {});
					});
				};
			`);
			const control = join(runDir(run.runId), "control", "processes", node.nodeId);
			mkdirSync(control, { recursive: true });
			const profile = join(control, "profile.sb");
			writeFileSync(profile, sandboxProfile({ worktree: node.cwd, workerHome: home, workerTmp: workerTmp(run.runId, node.nodeId), outbox, inbox: inboxDir(run.runId, node.nodeId), stateRoot: state, coordinatorWorktree: repository, gitCommonDir: run.gitCommonDir, hostHome: join(directory, "host"), sourceAgentDir: join(directory, "host", ".pi", "agent") }));
			const config = join(control, "launch.json");
			writeJson(config, {
				profile, executable, cwd: node.cwd, timeoutMs: 10000,
				statusFile: join(control, "status.json"), commandFile: join(control, "command.json"),
				environment: { HOME: home, TMPDIR: workerTmp(run.runId, node.nodeId), PATH: `${dirname(executable)}:/usr/bin:/bin`, PI_CODING_AGENT_DIR: agent, PI_SWARM_HOME: state, PI_SWARM_WORKER: "1", PI_SWARM_RUN: run.runId, PI_SWARM_NODE: node.nodeId, PI_SWARM_TOKEN: readFileSync(tokenFile(run.runId, node.nodeId), "utf8") },
				args: [pi, "--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--no-session", "--model", "openai-codex/gpt-5.4", "--extension", fixture],
			});
			supervisor = spawn(executable, [supervisorPath, config], { stdio: "ignore" });
		},
	};
	try {
		runtime = await SwarmRuntime.create({ cwd: repository, sessionId: "completion", objective: "Complete offline" }, processes);
		const worker = await runtime.act(runtime.root.nodeId, "spawn", { task: "Submit", timeoutMs: 10000 }) as NodeRecord;
		const outbox = outboxDir(runtime.runId, worker.nodeId);
		const until = async (condition: () => boolean) => {
			const deadline = Date.now() + 15000;
			while (!condition()) {
				if (Date.now() > deadline) throw new Error(`Completion fixture stalled: ${JSON.stringify(readNode(runtime!.runId, worker.nodeId))}`);
				await runtime!.poll();
				await new Promise(resolve => setTimeout(resolve, 25));
			}
		};
		await until(() => processes.status(worker)?.status === "paused" && readNode(runtime!.runId, worker.nodeId).result?.settledAt != null);
		const receipt = JSON.parse(readFileSync(join(outbox, "receipt.json"), "utf8"));
		expect(JSON.stringify(receipt)).toContain("Script completed");
		expect(JSON.stringify(receipt)).not.toContain("Still running");
		const submission = readNode(runtime.runId, worker.nodeId).result!;
		expect(git(worker.cwd, ["show", `${submission.commit}:feature`]).stdout.trim()).toBe("implemented");
		const pid = processes.status(worker)!.pid;
		await new Promise(resolve => setTimeout(resolve, 1000));
		await runtime.act(runtime.root.nodeId, "review", { nodeId: worker.nodeId, action: "request-changes", feedback: "Add tests" });
		await until(() => existsSync(join(outbox, "resumed")));
		expect(readFileSync(join(outbox, "delivery"), "utf8")).toContain("Add tests");
		expect(processes.status(worker)!.pid).toBe(pid);
		expect(readNode(runtime.runId, worker.nodeId).status).toBe("rework");
		expect(readNode(runtime.runId, worker.nodeId).result).toEqual(submission);
		writeFileSync(join(outbox, "continue"), "yes");
		await until(() => readNode(runtime!.runId, worker.nodeId).result?.text === "Revised report");
		expect(readNode(runtime.runId, worker.nodeId).result?.settledAt).toBeNull();
		await until(() => readNode(runtime!.runId, worker.nodeId).status === "failed");
		expect(readNode(runtime.runId, worker.nodeId).failure).toBe("Worker timed-out");
		expect(readNode(runtime.runId, worker.nodeId).result?.text).toBe("Revised report");
	} finally {
		try { await runtime?.kill(); } finally {
			supervisor?.kill("SIGTERM");
			await runtime?.close();
			if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	}
}, 30000);
