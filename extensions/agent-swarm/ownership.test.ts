import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { acquireRunOwnership, processExists, type OwnershipDependencies } from "./ownership.ts";
import { readRun, runFile, writeJson } from "./state.ts";
import { defaultConfig, SCHEMA_VERSION, type RunRecord } from "./types.ts";

test("permission-denied process probes still identify a live process", () => {
	const error = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
	const kill = spyOn(process, "kill").mockImplementation(() => { throw error; });
	try { expect(processExists(123)).toBe(true); }
	finally { kill.mockRestore(); }
});

function lockFixture(pid: number, acquire: () => boolean, release: () => void) {
	const holder = new EventEmitter() as ChildProcessWithoutNullStreams;
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	Object.assign(holder, { pid, stdin, stdout, stderr });
	let ownsLock = false;
	stdin.on("finish", () => { if (ownsLock) release(); queueMicrotask(() => holder.emit("close", 0)); });
	queueMicrotask(() => {
		ownsLock = acquire();
		if (ownsLock) stdout.write("ready");
		else { stderr.write("lock busy"); holder.emit("close", 75); }
	});
	return holder;
}

test("ownership lock rejects a second root, records heartbeats, and permits clean reacquisition", async () => {
	const previousHome = process.env.PI_SWARM_HOME;
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-owner-"));
	process.env.PI_SWARM_HOME = root;
	const run: RunRecord = {
		schemaVersion: SCHEMA_VERSION, runId: "run_test", rootNodeId: "node_root", rootSessionId: "test",
		ownerToken: "unowned", ownerPid: 0, heartbeatAt: 0, cwd: root, gitRoot: root, gitCommonDir: root,
		createdAt: 1, updatedAt: 1, status: "active", config: defaultConfig, tmuxSession: "test",
	};
	let locked = false;
	let nextPid = 8000;
	let now = 100;
	const live = new Set<number>([4242]);
	const dependencies: OwnershipDependencies = {
		platform: "darwin", pid: 4242, now: () => ++now,
		processExists: pid => live.has(pid),
		spawnLock: () => {
			const pid = nextPid++;
			live.add(pid);
			return lockFixture(pid, () => {
				if (locked) return false;
				locked = true;
				return true;
			}, () => { locked = false; live.delete(pid); });
		},
	};
	let owner: Awaited<ReturnType<typeof acquireRunOwnership>> | undefined;
	try {
		writeJson(runFile(run.runId), run);
		owner = await acquireRunOwnership(run.runId, dependencies);
		expect(owner.assertOwned().ownerPid).toBe(4242);
		await expect(acquireRunOwnership(run.runId, dependencies)).rejects.toThrow("ownership unavailable");
		owner.heartbeat();
		expect(readRun(run.runId).heartbeatAt).toBe(102);
		const first = owner;
		await first.release();
		expect(() => first.assertOwned()).toThrow("lost");
		owner = await acquireRunOwnership(run.runId, dependencies);
		expect(owner.token).not.toBe(first.token);
		expect(owner.assertOwned().ownerPid).toBe(4242);
	} finally {
		await owner?.release();
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
});
