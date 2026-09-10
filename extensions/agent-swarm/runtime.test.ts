import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repositoryInfo } from "./git.ts";
import { SwarmRuntime, type WorkerProcesses } from "./runtime.ts";
import { inboxDir, newId, readJson, readNode, responseFile, tokenFile, updateNode, workerHome, writeRequest } from "./state.ts";
import { SCHEMA_VERSION, type NodeRecord, type RequestKind, type SwarmResponse } from "./types.ts";

const macTest = process.platform === "darwin" ? test : test.skip;

macTest("authenticated hierarchy completes, reviews, and integrates only into its manager branch", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-swarm-runtime-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = join(directory, "state");
	git(directory, ["init", "-b", "main"]);
	git(directory, ["config", "user.name", "Swarm Test"]);
	git(directory, ["config", "user.email", "swarm@example.invalid"]);
	writeFileSync(join(directory, "initial"), "base\n");
	git(directory, ["add", "initial"]); git(directory, ["commit", "-m", "Initialize fixture"]);
	// State must live outside the source repository.
	const state = mkdtempSync(join(tmpdir(), "pi-swarm-runtime-state-"));
	process.env.PI_SWARM_HOME = state;
	const statuses = new Map<string, string>();
	const processes: WorkerProcesses = {
		async start(_run, node) { statuses.set(node.nodeId, "running"); },
		async set(node, status) { statuses.set(node.nodeId, status === "stopped" ? "exited" : status); },
		status(node) { return statuses.has(node.nodeId) ? { pid: null, status: statuses.get(node.nodeId)!, failure: null } : null; },
	};
	let runtime: SwarmRuntime | undefined;
	try {
		runtime = await SwarmRuntime.create({ cwd: directory, sessionId: "fixture", objective: "Implement a nested change" }, processes);
		let active = runtime;
		const original = repositoryInfo(directory).head;
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
		await request(manager.nodeId, "ready", { sessionId: "manager" });
		const worker = await request(manager.nodeId, "spawn", { role: "worker", task: "Implement the change" }) as NodeRecord;
		await request(worker.nodeId, "ready", { sessionId: "worker" });
		await expect(request(worker.nodeId, "spawn", { task: "Bypass hierarchy" })).rejects.toThrow("cannot spawn");
		await expect(request(manager.nodeId, "complete", { text: "Too early" })).rejects.toThrow("descendants");
		await request(worker.nodeId, "send", { nodeId: manager.nodeId, body: "Implementation started" });
		writeFileSync(join(worker.cwd, "feature"), "implemented\n");
		await request(worker.nodeId, "complete", { text: "Implemented feature", verification: "Fixture asserts file contents" });
		await request(manager.nodeId, "review", { nodeId: worker.nodeId, action: "request-changes", feedback: "Add a second line" });
		writeFileSync(join(worker.cwd, "feature"), "implemented\nrevised\n");
		await request(worker.nodeId, "complete", { text: "Revised feature" });
		const result = readNode(active.runId, worker.nodeId).result!;
		expect(result.commit).not.toBe(original);
		const reviewer = await request(manager.nodeId, "spawn", { role: "reviewer", task: "Inspect the result", reviewTargetId: worker.nodeId }) as NodeRecord;
		expect(repositoryInfo(reviewer.cwd).head).toBe(result.commit!);
		await request(reviewer.nodeId, "ready", { sessionId: "reviewer" });
		await request(reviewer.nodeId, "complete", { text: "Verified" });
		await request(manager.nodeId, "review", { nodeId: reviewer.nodeId, action: "accept" });
		await request(manager.nodeId, "review", { nodeId: worker.nodeId, action: "accept" });
		await expect(active.act(active.root.nodeId, "integrate", { nodeId: manager.nodeId })).rejects.toThrow("accepted direct-child commit");
		writeFileSync(join(manager.cwd, "feature"), "conflicting change\n");
		git(manager.cwd, ["add", "feature"]); git(manager.cwd, ["commit", "-m", "Create fixture conflict"]);
		const beforeConflict = repositoryInfo(manager.cwd).head;
		await expect(request(manager.nodeId, "integrate", { nodeId: worker.nodeId })).rejects.toThrow("conflict");
		expect(repositoryInfo(manager.cwd).head).toBe(beforeConflict);
		expect(repositoryInfo(manager.cwd).status).toBe("");
		expect(readNode(active.runId, worker.nodeId).integrationCommit).toBeNull();
		writeFileSync(join(manager.cwd, "feature"), "implemented\nrevised\n");
		git(manager.cwd, ["add", "feature"]); git(manager.cwd, ["commit", "-m", "Resolve fixture conflict"]);
		await request(manager.nodeId, "integrate", { nodeId: worker.nodeId });
		expect(readFileSync(join(manager.cwd, "feature"), "utf8")).toBe("implemented\nrevised\n");
		expect(repositoryInfo(directory).head).toBe(original);
		const workerSnapshot = readJson<{ nodes: NodeRecord[] }>(join(inboxDir(active.runId, worker.nodeId), "snapshot.json"))!;
		expect(workerSnapshot.nodes.map((node) => node.nodeId).sort()).toEqual([manager.nodeId, worker.nodeId].sort());
		writeFileSync(join(manager.cwd, "uncommitted"), "Retain this work");
		await expect(active.clear()).rejects.toThrow("/swarm:kill");
		expect(statuses.get(manager.nodeId)).toBe("running");
		rmSync(join(manager.cwd, "uncommitted"));
		const queuedId = newId("req");
		const runId = active.runId;
		await active.close();
		writeRequest({ schemaVersion: SCHEMA_VERSION, requestId: queuedId, runId, nodeId: manager.nodeId, token: readFileSync(tokenFile(runId, manager.nodeId), "utf8"), kind: "send", payload: { nodeId: active.root.nodeId, body: "Queued while controller was absent" }, expectedVersion: readNode(runId, manager.nodeId).version, createdAt: Date.now() });
		runtime = await SwarmRuntime.resume(runId, processes);
		active = runtime;
		expect(readJson<SwarmResponse>(responseFile(runId, manager.nodeId, queuedId))?.ok).toBe(true);
		await active.poll();
		expect(active.view().messages.filter((message) => message.body === "Queued while controller was absent")).toHaveLength(1);
		const reviewerSessions = join(workerHome(runId, reviewer.nodeId), ".pi", "agent", "sessions");
		mkdirSync(reviewerSessions, { recursive: true });
		writeFileSync(join(reviewerSessions, "review.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { cost: { total: 1.25 } } } })}\n`);
		await request(manager.nodeId, "cleanup", { nodeId: reviewer.nodeId });
		expect(readNode(runId, reviewer.nodeId).estimatedCost).toBe(1.25);
		expect(existsSync(workerHome(runId, reviewer.nodeId))).toBe(false);
		await request(manager.nodeId, "complete", { text: "Combined child work" });
		await active.act(active.root.nodeId, "review", { nodeId: manager.nodeId, action: "accept" });
		expect(readNode(active.runId, manager.nodeId).status).toBe("completed");
		const rootIntegration = await active.act(active.root.nodeId, "integrate", { nodeId: manager.nodeId }) as { commit: string };
		expect(readFileSync(join(directory, "feature"), "utf8")).toBe("implemented\nrevised\n");
		expect(repositoryInfo(directory).head).toBe(rootIntegration.commit);
		expect(readNode(active.runId, manager.nodeId).integrationCommit).toBe(rootIntegration.commit);
		await active.close();
		runtime = await SwarmRuntime.resume(active.runId, processes);
		expect(runtime.root.task).toBe("Implement a nested change");
		const managerSessions = join(workerHome(runId, manager.nodeId), ".pi", "agent", "sessions");
		mkdirSync(managerSessions, { recursive: true });
		writeFileSync(join(managerSessions, "manager.jsonl"), `${JSON.stringify({ type: "compaction", usage: { cost: { total: 2.5 } } })}\n`);
		await runtime.clear();
		await runtime.close();
		runtime = undefined;
		expect(existsSync(workerHome(runId, manager.nodeId))).toBe(false);
		expect(readNode(runId, manager.nodeId).estimatedCost).toBe(2.5);
		expect(readNode(runId, reviewer.nodeId).estimatedCost).toBe(1.25);
		await expect(SwarmRuntime.resume(runId, processes)).rejects.toThrow("cleared");
	} finally {
		await runtime?.close();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
}, 30000);

macTest("per-worker timeout is bounded and survives restart", async () => {
	const repository = mkdtempSync(join(tmpdir(), "pi-swarm-timeout-repo-"));
	const state = mkdtempSync(join(tmpdir(), "pi-swarm-timeout-state-"));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = state;
	git(repository, ["init", "-b", "main"]);
	git(repository, ["config", "user.name", "Swarm Test"]);
	git(repository, ["config", "user.email", "swarm@example.invalid"]);
	writeFileSync(join(repository, "initial"), "base\n");
	git(repository, ["add", "initial"]);
	git(repository, ["commit", "-m", "Initialize fixture"]);
	const starts: number[] = [];
	const processes: WorkerProcesses = {
		async start(run, node) { starts.push(node.timeoutMs ?? run.config.workerTimeoutMs); },
		async set() {},
		status() { return null; },
	};
	let runtime: SwarmRuntime | undefined;
	try {
		runtime = await SwarmRuntime.create({ cwd: repository, sessionId: "timeout-fixture", objective: "Test timeouts" }, processes);
		const before = runtime.nodes().length;
		await expect(runtime.act(runtime.root.nodeId, "spawn", { task: "Too long", timeoutMs: runtime.run.config.maxWorkerTimeoutMs + 1 })).rejects.toThrow("timeoutMs");
		expect(runtime.nodes()).toHaveLength(before);
		const timeoutMs = 45 * 60_000;
		const spawnedAt = Date.now();
		const worker = await runtime.act(runtime.root.nodeId, "spawn", { task: "Long benchmark", timeoutMs }) as NodeRecord;
		expect(worker.timeoutMs).toBe(timeoutMs);
		expect(worker.deadlineAt).toBeGreaterThanOrEqual(spawnedAt + timeoutMs);
		expect(worker.deadlineAt).toBeLessThanOrEqual(Date.now() + timeoutMs);
		updateNode(runtime.runId, worker.nodeId, (node) => { node.status = "stopped"; });
		await runtime.act(runtime.root.nodeId, "restart", { nodeId: worker.nodeId });
		expect(starts).toEqual([timeoutMs, timeoutMs]);
		expect(readNode(runtime.runId, worker.nodeId).timeoutMs).toBe(timeoutMs);
	} finally {
		await runtime?.close();
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(repository, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
}, 30000);
