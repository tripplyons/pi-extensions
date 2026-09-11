import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { runMixture, workerArgs, type WorkerResult } from "./runner.ts";

const MODELS = ["openrouter/model-a", "openrouter/model-b", "openrouter/model-c"];

const messageEnd = (text: string, cost = 0.01) => JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
		stopReason: "stop",
	},
});

interface Behavior {
	output?: string;
	exitCode?: number | null;
	hang?: boolean;
}

class FakeChild extends EventEmitter {
	pid = 999_999_999;
	stdout = new PassThrough();
	stderr = new PassThrough();
	killed: string[] = [];
	constructor(readonly behavior: Behavior) {
		super();
		queueMicrotask(() => {
			if (behavior.output) this.stdout.emit("data", Buffer.from(`${behavior.output}\n`));
			if (!behavior.hang) this.emit("close", behavior.exitCode ?? 0);
		});
	}
	kill(signal: string) {
		this.killed.push(signal);
		queueMicrotask(() => this.emit("close", null));
		return true;
	}
}

const fakeSpawn = (behaviors: Record<string, Behavior>, seen: { active: number; max: number; calls: Array<{ args: string[]; options: any }> }) =>
	(command: string, args: string[], options: any) => {
		expect(command).toBe("/usr/bin/sandbox-exec");
		const model = args[args.indexOf("--model") + 1];
		seen.calls.push({ args, options });
		seen.active++;
		seen.max = Math.max(seen.max, seen.active);
		const child = new FakeChild(behaviors[model] ?? {});
		child.on("close", () => { seen.active--; });
		return child as any;
	};

const setupDirs = () => {
	const root = mkdtempSync(join(tmpdir(), "mixture-run-"));
	process.env.PI_MIXTURE_HOME = join(root, "state");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), JSON.stringify({ openrouter: { key: "fake" } }));
	return root;
};

const initRepo = (dir: string) => {
	execFileSync("git", ["init", "-q", dir]);
	execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"]);
	return dir;
};

let savedMixtureHome: string | undefined;
let savedAgentDir: string | undefined;
beforeEach(() => {
	savedMixtureHome = process.env.PI_MIXTURE_HOME;
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	setupDirs();
});
afterEach(() => {
	if (savedMixtureHome === undefined) delete process.env.PI_MIXTURE_HOME;
	else process.env.PI_MIXTURE_HOME = savedMixtureHome;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

describe("workerArgs", () => {
	test("passes provider/model through --model with the task", () => {
		const args = workerArgs("openrouter/foo/bar", "medium", "Do the thing");
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("openrouter/foo/bar");
		expect(args.at(-1)).toBe("Task: Do the thing");
	});
});

describe("runMixture", () => {
	test("runs all models concurrently and collects labeled outputs", async () => {
		const cwd = initRepo(mkdtempSync(join(tmpdir(), "mixture-repo-")));
		const seen = { active: 0, max: 0, calls: [] as Array<{ args: string[]; options: any }> };
		const results = await runMixture(
			{ task: "Say hi", models: MODELS, timeoutMs: 30_000, thinking: "medium", cwd },
			{ spawnChild: fakeSpawn({ "openrouter/model-a": { output: messageEnd("A says hi") }, "openrouter/model-b": { output: messageEnd("B says hi") }, "openrouter/model-c": { output: messageEnd("C says hi") } }, seen), runId: "mix_test1" },
		);
		expect(seen.max).toBe(3);
		expect(results.map((r) => r.model)).toEqual(MODELS);
		expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
		expect(results.map((r) => r.output)).toEqual(["A says hi", "B says hi", "C says hi"]);
		expect(results[0].usage.turns).toBe(1);
		expect(results[0].usage.input).toBe(10);
		expect(results.map((r) => r.branch)).toEqual([
			"pi-mixture/mix_test1/slot-0",
			"pi-mixture/mix_test1/slot-1",
			"pi-mixture/mix_test1/slot-2",
		]);
		for (const call of seen.calls) expect(call.options.cwd).not.toBe(cwd);
		const worktrees = execFileSync("git", ["-C", cwd, "worktree", "list", "--porcelain"]).toString();
		expect(worktrees).not.toContain("pi-mixture");
	});

	test("a failed worker does not block the others", async () => {
		const cwd = initRepo(mkdtempSync(join(tmpdir(), "mixture-repo-")));
		const seen = { active: 0, max: 0, calls: [] as Array<{ args: string[]; options: any }> };
		const results: WorkerResult[] = await runMixture(
			{ task: "Say hi", models: MODELS, timeoutMs: 30_000, thinking: "medium", cwd },
			{ spawnChild: fakeSpawn({ "openrouter/model-a": { output: messageEnd("A ok") }, "openrouter/model-b": { exitCode: 1 }, "openrouter/model-c": { output: messageEnd("C ok") } }, seen), runId: "mix_test2" },
		);
		expect(results.map((r) => r.status)).toEqual(["ok", "failed", "ok"]);
		expect(results[1].error).toContain("exited 1");
		expect(results[2].output).toBe("C ok");
	});

	test("a hung worker times out while others finish", async () => {
		const cwd = initRepo(mkdtempSync(join(tmpdir(), "mixture-repo-")));
		const seen = { active: 0, max: 0, calls: [] as Array<{ args: string[]; options: any }> };
		const results = await runMixture(
			{ task: "Say hi", models: MODELS, timeoutMs: 50, thinking: "medium", cwd },
			{ spawnChild: fakeSpawn({ "openrouter/model-a": { output: messageEnd("A ok") }, "openrouter/model-b": { hang: true }, "openrouter/model-c": { output: messageEnd("C ok") } }, seen), runId: "mix_test3" },
		);
		expect(results.map((r) => r.status)).toEqual(["ok", "timeout", "ok"]);
		expect(results[1].error).toContain("exceeded 50ms");
	});

	test("missing stored credentials fall back to inherited env", async () => {
		execFileSync("rm", [join(process.env.PI_CODING_AGENT_DIR!, "auth.json")]);
		process.env.OPENROUTER_API_KEY = "test-key";
		const cwd = initRepo(mkdtempSync(join(tmpdir(), "mixture-repo-")));
		const seen = { active: 0, max: 0, calls: [] as Array<{ args: string[]; options: any }> };
		const results = await runMixture(
			{ task: "Say hi", models: MODELS, timeoutMs: 30_000, thinking: "medium", cwd },
			{ spawnChild: fakeSpawn({ "openrouter/model-a": { output: messageEnd("A") }, "openrouter/model-b": { output: messageEnd("B") }, "openrouter/model-c": { output: messageEnd("C") } }, seen), runId: "mix_test5" },
		);
		expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
		for (const call of seen.calls) expect(call.options.env.OPENROUTER_API_KEY).toBe("test-key");
		delete process.env.OPENROUTER_API_KEY;
	});

	test("a settled worker resolves without waiting for process exit", async () => {
		const cwd = initRepo(mkdtempSync(join(tmpdir(), "mixture-repo-")));
		const seen = { active: 0, max: 0, calls: [] as Array<{ args: string[]; options: any }> };
		const settled = JSON.stringify({ type: "agent_settled" });
		const children: FakeChild[] = [];
		const spawnChild = (command: string, args: string[], options: any) => {
			const child = new FakeChild({ output: `${messageEnd("Done")}\n${settled}`, hang: true });
			children.push(child);
			seen.calls.push({ args, options });
			return child as any;
		};
		const results = await runMixture(
			{ task: "Say hi", models: [MODELS[0]], timeoutMs: 30_000, thinking: "medium", cwd },
			{ spawnChild, runId: "mix_test6" },
		);
		expect(results[0].status).toBe("ok");
		expect(results[0].output).toBe("Done");
		expect(children[0].killed).toContain("SIGTERM");
	});

	test("outside a git repo all workers share the cwd with no branches", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mixture-plain-"));
		const seen = { active: 0, max: 0, calls: [] as Array<{ args: string[]; options: any }> };
		const results = await runMixture(
			{ task: "Say hi", models: MODELS, timeoutMs: 30_000, thinking: "medium", cwd },
			{ spawnChild: fakeSpawn({ "openrouter/model-a": { output: messageEnd("A") }, "openrouter/model-b": { output: messageEnd("B") }, "openrouter/model-c": { output: messageEnd("C") } }, seen), runId: "mix_test4" },
		);
		expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
		expect(results.every((r) => r.branch === undefined)).toBe(true);
		for (const call of seen.calls) expect(call.options.cwd).toBe(cwd);
	});
});
