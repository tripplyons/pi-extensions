import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedBranch, repositoryInfo, setGitRunnerForTests } from "./git.ts";
import { SwarmRuntime, type WorkerProcesses } from "./runtime.ts";
import { inboxDir, newId, readJson, readNode, responseFile, tokenFile, updateNode, workerHome, writeRequest } from "./state.ts";
import { SCHEMA_VERSION, type NodeRecord, type RequestKind, type SwarmResponse } from "./types.ts";

afterEach(() => setGitRunnerForTests());

function mockGit(root: string) {
	const repositories = new Map<string, { root: string; branch: string; head: string; dirty: boolean }>([
		[root, { root, branch: "main", head: "0".repeat(40), dirty: false }],
	]);
	let sequence = 0;
	let failNextMerge = false;
	const runner = (cwd: string, args: string[]) => {
		const repo = repositories.get(cwd);
		if (args[0] === "worktree" && args[1] === "add") {
			const branch = args[3]!;
			const path = args[4]!;
			const revision = args[5] === "HEAD" || args[5] === undefined ? repositories.get(cwd)!.head : args[5]!;
			mkdirSync(path, { recursive: true });
			repositories.set(realpathSync(path), { root, branch, head: revision, dirty: false });
			return { ok: true, stdout: "", stderr: "" };
		}
		if (args[0] === "worktree" && args[1] === "remove") {
			const path = args.at(-1)!;
			repositories.delete(path);
			rmSync(path, { recursive: true, force: true });
			return { ok: true, stdout: "", stderr: "" };
		}
		if (args[0] === "branch") return { ok: true, stdout: "", stderr: "" };
		if (!repo) throw new Error(`Unknown mocked repository: ${cwd} (${args.join(" ")})`);
		if (args[0] === "rev-parse" && args.includes("--git-path")) {
			const names = args.slice(args.indexOf("--git-path") + 1).filter(value => value !== "--git-path");
			return { ok: true, stdout: `${names.map(name => join(cwd, ".git", name)).join("\n")}\n`, stderr: "" };
		}
		if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return { ok: true, stdout: `${cwd}\n${root}/.git\n`, stderr: "" };
		if (args[0] === "rev-parse" && args[1] === "HEAD") return { ok: true, stdout: `${repo.head}\n`, stderr: "" };
		if (args[0] === "status") return { ok: true, stdout: args.includes("--branch")
			? `# branch.oid ${repo.head}\n# branch.head ${repo.branch}\n${repo.dirty ? "? dirty\n" : ""}`
			: repo.dirty ? "? dirty\n" : "", stderr: "" };
		if (args[0] === "ls-tree" || args[0] === "ls-files") return { ok: true, stdout: "fixture\0", stderr: "" };
		if (args[0] === "check-attr") return { ok: true, stdout: `fixture\0${args.at(-1)}\0unspecified\0`, stderr: "" };
		if (args[0] === "add") return { ok: true, stdout: "", stderr: "" };
		if (args[0] === "diff" && args.includes("--cached")) return { ok: !repo.dirty, stdout: "", stderr: "" };
		if (args[0] === "commit") { repo.head = (++sequence).toString(16).padStart(40, "0"); repo.dirty = false; return { ok: true, stdout: "", stderr: "" }; }
		if (args[0] === "merge-base") return { ok: true, stdout: "", stderr: "" };
		if (args[0] === "merge" && args[1] === "--abort") return { ok: true, stdout: "", stderr: "" };
		if (args[0] === "merge") {
			if (failNextMerge) { failNextMerge = false; return { ok: false, stdout: "", stderr: "mock conflict" }; }
			repo.head = (++sequence).toString(16).padStart(40, "0");
			return { ok: true, stdout: "", stderr: "" };
		}
		throw new Error(`Unexpected mocked Git command: ${args.join(" ")}`);
	};
	setGitRunnerForTests(runner as any);
	return {
		failMerge() { failNextMerge = true; },
		setDirty(path: string, dirty: boolean) { repositories.get(path)!.dirty = dirty; },
	};
}

function processes() {
	const statuses = new Map<string, string>();
	const value: WorkerProcesses = {
		async start(_run, node) { statuses.set(node.nodeId, "running"); },
		async set(node, status) { statuses.set(node.nodeId, status === "stopped" ? "exited" : status); },
		status(node) { return statuses.has(node.nodeId) ? { pid: null, status: statuses.get(node.nodeId)!, failure: null } : null; },
	};
	return { value, statuses };
}

test("mocked Git boundaries preserve authenticated hierarchy, review, integration, resume, and cleanup", async () => {
	const repository = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-runtime-unit-")));
	const state = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-runtime-state-")));
	writeFileSync(join(repository, "initial"), "base\n");
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = state;
	const git = mockGit(repository);
	const workerProcesses = processes();
	let runtime: SwarmRuntime | undefined;
	try {
		runtime = await SwarmRuntime.create({ cwd: repository, sessionId: "fixture", objective: "Implement a nested change" }, workerProcesses.value);
		let active = runtime;
		const request = async (nodeId: string, kind: RequestKind, payload: Record<string, unknown>) => {
			const actor = readNode(active.runId, nodeId);
			const requestId = newId("req");
			writeRequest({ schemaVersion: SCHEMA_VERSION, requestId, runId: active.runId, nodeId, token: readFileSync(tokenFile(active.runId, nodeId), "utf8"), kind, payload, expectedVersion: actor.version, createdAt: Date.now() });
			await active.poll();
			const response = readJson<SwarmResponse>(responseFile(active.runId, nodeId, requestId))!;
			if (!response.ok) throw new Error(response.error);
			return response.result;
		};

		const manager = await active.act(active.root.nodeId, "spawn", { role: "manager", task: "Manage the change" }) as NodeRecord;
		expect(manager.branch).toBe(generatedBranch(active.runId, manager.nodeId));
		await request(manager.nodeId, "ready", { sessionId: "manager" });
		const worker = await request(manager.nodeId, "spawn", { role: "worker", task: "Implement the change" }) as NodeRecord;
		await request(worker.nodeId, "ready", { sessionId: "worker" });
		await expect(request(worker.nodeId, "spawn", { task: "Bypass hierarchy" })).rejects.toThrow("cannot spawn");
		await expect(request(manager.nodeId, "complete", { text: "Too early" })).rejects.toThrow("descendants");
		await request(worker.nodeId, "send", { nodeId: manager.nodeId, body: "Implementation started" });
		git.setDirty(worker.cwd, true);
		await request(worker.nodeId, "complete", { text: "Implemented feature", verification: "Mock boundary assertions" });
		const first = readNode(active.runId, worker.nodeId).result!;
		await request(worker.nodeId, "heartbeat", { settleSubmission: first.submittedAt });
		expect(workerProcesses.statuses.get(worker.nodeId)).toBe("paused");
		await request(manager.nodeId, "review", { nodeId: worker.nodeId, action: "request-changes", feedback: "Revise it" });
		expect(readNode(active.runId, worker.nodeId).status).toBe("rework");
		await expect(request(worker.nodeId, "complete", { text: first.text, verification: first.verification })).rejects.toThrow("unchanged");
		git.setDirty(worker.cwd, true);
		await request(worker.nodeId, "complete", { text: "Revised feature" });
		const revised = readNode(active.runId, worker.nodeId).result!;
		await request(worker.nodeId, "heartbeat", { settleSubmission: revised.submittedAt });

		const reviewer = await request(manager.nodeId, "spawn", { role: "reviewer", task: "Inspect", reviewTargetId: worker.nodeId }) as NodeRecord;
		expect(repositoryInfo(reviewer.cwd).head).toBe(revised.commit!);
		await request(reviewer.nodeId, "ready", { sessionId: "reviewer" });
		await request(reviewer.nodeId, "complete", { text: "Verified" });
		await request(reviewer.nodeId, "heartbeat", { settleSubmission: readNode(active.runId, reviewer.nodeId).result!.submittedAt });
		await request(manager.nodeId, "review", { nodeId: reviewer.nodeId, action: "accept" });
		await request(manager.nodeId, "review", { nodeId: worker.nodeId, action: "accept" });
		git.failMerge();
		await expect(request(manager.nodeId, "integrate", { nodeId: worker.nodeId })).rejects.toThrow("mock conflict");
		expect(readNode(active.runId, worker.nodeId).integrationCommit).toBeNull();
		await request(manager.nodeId, "integrate", { nodeId: worker.nodeId });
		expect(readNode(active.runId, worker.nodeId).integrationCommit).not.toBeNull();

		const snapshot = readJson<{ nodes: NodeRecord[] }>(join(inboxDir(active.runId, worker.nodeId), "snapshot.json"))!;
		expect(snapshot.nodes.map(node => node.nodeId).sort()).toEqual([manager.nodeId, worker.nodeId].sort());
		const queuedId = newId("req");
		const runId = active.runId;
		await active.close();
		writeRequest({ schemaVersion: SCHEMA_VERSION, requestId: queuedId, runId, nodeId: manager.nodeId, token: readFileSync(tokenFile(runId, manager.nodeId), "utf8"), kind: "send", payload: { nodeId: active.root.nodeId, body: "Queued while absent" }, expectedVersion: readNode(runId, manager.nodeId).version, createdAt: Date.now() });
		runtime = await SwarmRuntime.resume(runId, workerProcesses.value);
		active = runtime;
		expect(readJson<SwarmResponse>(responseFile(runId, manager.nodeId, queuedId))?.ok).toBe(true);
		expect(active.view().messages.filter(item => item.body === "Queued while absent")).toHaveLength(1);

		const reviewerSessions = join(workerHome(runId, reviewer.nodeId), ".pi", "agent", "sessions");
		mkdirSync(reviewerSessions, { recursive: true });
		writeFileSync(join(reviewerSessions, "review.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { cost: { total: 1.25 } } } })}\n`);
		await request(manager.nodeId, "cleanup", { nodeId: reviewer.nodeId });
		expect(readNode(runId, reviewer.nodeId).estimatedCost).toBe(1.25);
		expect(existsSync(workerHome(runId, reviewer.nodeId))).toBe(false);

		await request(manager.nodeId, "complete", { text: "Combined child work" });
		await active.act(active.root.nodeId, "review", { nodeId: manager.nodeId, action: "accept" });
		const integrated = await active.act(active.root.nodeId, "integrate", { nodeId: manager.nodeId }) as { commit: string };
		expect(repositoryInfo(repository).head).toBe(integrated.commit);
		await active.clear();
		await active.close();
		runtime = undefined;
		await expect(SwarmRuntime.resume(runId, workerProcesses.value)).rejects.toThrow("cleared");
	} finally {
		await runtime?.close();
		if (previous === undefined) delete process.env.PI_SWARM_HOME;
		else process.env.PI_SWARM_HOME = previous;
		rmSync(repository, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
}, 10_000);

test("per-worker timeout is bounded and survives restart with mocked Git", async () => {
	const repository = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-timeout-unit-")));
	const state = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-timeout-state-")));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = state;
	mockGit(repository);
	const starts: number[] = [];
	let processStatus: string | undefined;
	const workerProcesses: WorkerProcesses = {
		async start(run, node) { starts.push(node.timeoutMs ?? run.config.workerTimeoutMs); },
		async set() {},
		status() { return processStatus ? { pid: null, status: processStatus, failure: null } : null; },
	};
	let runtime: SwarmRuntime | undefined;
	try {
		runtime = await SwarmRuntime.create({ cwd: repository, sessionId: "timeout", objective: "Test timeouts" }, workerProcesses);
		await expect(runtime.act(runtime.root.nodeId, "spawn", { task: "Too long", timeoutMs: runtime.run.config.maxWorkerTimeoutMs + 1 })).rejects.toThrow("timeoutMs");
		const timeoutMs = 45 * 60_000;
		const worker = await runtime.act(runtime.root.nodeId, "spawn", { task: "Long benchmark", timeoutMs }) as NodeRecord;
		expect(worker.timeoutMs).toBe(timeoutMs);
		updateNode(runtime.runId, worker.nodeId, node => { node.status = "stopped"; });
		await runtime.act(runtime.root.nodeId, "restart", { nodeId: worker.nodeId });
		expect(starts).toEqual([timeoutMs, timeoutMs]);
		updateNode(runtime.runId, worker.nodeId, node => { node.status = "running"; });
		updateNode(runtime.runId, worker.nodeId, node => { node.status = "awaiting-review"; node.result = { text: "Saved", commit: "saved", submittedAt: Date.now(), settledAt: null }; });
		processStatus = "timed-out";
		await runtime.poll();
		expect(readNode(runtime.runId, worker.nodeId)).toMatchObject({ status: "failed", failure: "Worker timed-out", result: { commit: "saved" } });
	} finally {
		await runtime?.close();
		if (previous === undefined) delete process.env.PI_SWARM_HOME;
		else process.env.PI_SWARM_HOME = previous;
		rmSync(repository, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});
