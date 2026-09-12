import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./git.ts";
import { createWorkerProcesses, inheritedFastEnvironment, workerPath } from "./process.ts";
import { SwarmRuntime } from "./runtime.ts";
import { readNode, workerHome } from "./state.ts";
import { captureWindow, tmux } from "./tmux.ts";
import type { NodeRecord } from "./types.ts";

test("worker launch environment preserves enabled and disabled fast mode", () => {
	expect(inheritedFastEnvironment(true)).toBe("1");
	expect(inheritedFastEnvironment(false)).toBe("0");
});

test("worker PATH retains host tool directories after required executable directories", () => {
	expect(workerPath(["/node/bin/node", "/opt/homebrew/Cellar/git/bin/git", "/opt/homebrew/Cellar/tmux/bin/tmux"],
		"/opt/homebrew/bin:/custom/bin:/node/bin::.:relative/bin")).toBe(
		"/node/bin:/opt/homebrew/Cellar/git/bin:/opt/homebrew/Cellar/tmux/bin:/opt/homebrew/bin:/custom/bin:/usr/bin:/bin:/usr/sbin:/sbin");
	expect(workerPath(["/node/bin/node"], "")).toBe("/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
});

const liveTest = process.platform === "darwin" && process.env.PI_SWARM_TEST_MODEL ? test : test.skip;

for (const role of ["worker", "manager"] as const) liveTest(`real tmux ${role} authenticates, runs native tools, and submits a controlled commit`, async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-live-repo-"));
	const state = mkdtempSync(join(tmpdir(), "pi-swarm-live-state-"));
	const previous = process.env.PI_SWARM_HOME;
	const previousPath = process.env.PATH;
	const tools = mkdtempSync(join(tmpdir(), "pi-swarm-live-tools-"));
	writeFileSync(join(tools, "swarm-path-proof"), "#!/bin/sh\nprintf 'verified\\n'\n");
	chmodSync(join(tools, "swarm-path-proof"), 0o700);
	process.env.PATH = `${tools}:${previousPath ?? "/usr/bin:/bin"}`;
	process.env.PI_SWARM_HOME = state;
	let runtime: SwarmRuntime | undefined;
	try {
		git(directory, ["init", "-b", "main"]);
		git(directory, ["config", "user.name", "Swarm Test"]);
		git(directory, ["config", "user.email", "swarm@example.invalid"]);
		writeFileSync(join(directory, "initial"), "base\n");
		git(directory, ["add", "initial"]);
		git(directory, ["commit", "-m", "Initialize fixture"]);
		runtime = await SwarmRuntime.create({ cwd: directory, sessionId: "live-fixture", objective: "Verify one real worker", model: process.env.PI_SWARM_TEST_MODEL, thinking: "low" }, createWorkerProcesses(fileURLToPath(new URL("./index.ts", import.meta.url))));
		const task = role === "worker"
			? "Use bash to run the installed command swarm-path-proof and redirect its output to a file named proof. The command is on PATH and prints verified followed by a newline. Do not substitute echo, printf, or a file tool for this command. Then call swarm_complete with text 'Verified live worker' and verification describing the file. Do not commit with git, spawn agents, or change other files."
			: "Verify the nested swarm workflow. Spawn one worker tasked to write exactly verified followed by a newline to a file named proof, then submit with swarm_complete. Wait for its result. Spawn a reviewer targeting that worker's result commit. The reviewer must inspect proof and submit findings with swarm_complete. Accept both results with swarm_review, integrate the implementation worker with swarm_integrate, verify proof in your own worktree, then submit your combined result with swarm_complete. Do not run git mutations yourself. Read swarm_task for updated messages and node states. You can end a turn while waiting; the inbox will wake you.";
		const worker = await runtime.act(runtime.root.nodeId, "spawn", { role, task }) as NodeRecord;
		const deadline = Date.now() + 180000;
		while (Date.now() < deadline) {
			await runtime.poll();
			const node = readNode(runtime.runId, worker.nodeId);
			if (node.status === "awaiting-review") break;
			if (node.status === "failed") throw new Error(`${node.failure}\n${captureWindow(node.tmuxSession!, node.tmuxWindow!)}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const completed = readNode(runtime.runId, worker.nodeId);
		expect(completed.status).toBe("awaiting-review");
		expect(completed.result?.commit).toMatch(/^[a-f0-9]{40}$/);
		expect(readFileSync(join(worker.cwd, "proof"), "utf8")).toBe("verified\n");
		expect(git(directory, ["status", "--porcelain"]).stdout).toBe("");
		const sessionDirectory = join(workerHome(runtime.runId, worker.nodeId), ".pi", "agent", "sessions");
		const toolCalls = readdirSync(sessionDirectory, { recursive: true }).filter((path) => String(path).endsWith(".jsonl")).flatMap((path) =>
			readFileSync(join(sessionDirectory, String(path)), "utf8").trim().split("\n").map((line) => JSON.parse(line)).flatMap((entry) =>
				Array.isArray(entry.message?.content) ? entry.message.content.filter((item: any) => item.type === "toolCall") : []));
		const calls = toolCalls.map((item: any) => item.name);
		expect(calls).not.toContain("exec");
		expect(calls).toContain("swarm_complete");
		expect(calls).not.toContain("wait");
		if (role === "manager") expect(runtime.nodes().map((node) => node.role).sort()).toEqual(["coordinator", "manager", "reviewer", "worker"]);
		if (role === "worker") {
			expect(toolCalls.some((item: any) => item.name === "bash" && item.arguments?.command?.includes("swarm-path-proof"))).toBe(true);
			await runtime.act(runtime.root.nodeId, "review", { nodeId: worker.nodeId, action: "request-changes", feedback: "Replace proof with exactly revised followed by a newline. Submit again with swarm_complete after verifying the contents." });
			const reworkDeadline = Date.now() + 60000;
			while (Date.now() < reworkDeadline) {
				await runtime.poll();
				if (readNode(runtime.runId, worker.nodeId).status === "awaiting-review") break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(readNode(runtime.runId, worker.nodeId).status).toBe("awaiting-review");
			expect(readNode(runtime.runId, worker.nodeId).result?.commit).not.toBe(completed.result?.commit);
			expect(readFileSync(join(worker.cwd, "proof"), "utf8")).toBe("revised\n");
		}
		await runtime.act(runtime.root.nodeId, "review", { nodeId: worker.nodeId, action: "accept" });
		await runtime.clear();
		await runtime.close();
		runtime = undefined;
	} finally {
		if (runtime) {
			await runtime.kill();
			tmux(["kill-session", "-t", runtime.run.tmuxSession], true);
			await runtime.close();
		}
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		rmSync(tools, { recursive: true, force: true });
		rmSync(directory, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
}, 210000);
