import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { ensureDir, newToken, readRun, runDir, runFile, writeJson } from "./state.ts";
import { systemScheduler, type Scheduler } from "../scheduler.ts";

export function processExists(pid: number) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}

export interface OwnershipDependencies {
	platform: NodeJS.Platform;
	pid: number;
	now: () => number;
	processExists: (pid: number) => boolean;
	spawnLock: (lockPath: string) => ChildProcessWithoutNullStreams;
	scheduler: Scheduler;
}

const ownershipDependencies: OwnershipDependencies = {
	platform: process.platform,
	pid: process.pid,
	now: Date.now,
	processExists,
	scheduler: systemScheduler,
	spawnLock: lockPath => spawn("/usr/bin/lockf", ["-k", "-t", "0", lockPath, "/bin/sh", "-c", "printf ready; exec /bin/cat >/dev/null"], {
		stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" },
	}),
};

export async function acquireRunOwnership(runId: string, overrides: Partial<OwnershipDependencies> = {}) {
	const dependencies = { ...ownershipDependencies, ...overrides };
	if (dependencies.platform !== "darwin") throw new Error("Swarm ownership requires macOS lockf");
	const control = join(runDir(runId), "control");
	ensureDir(control);
	// Keep the inode. Unlinking a flock file allows two owners to lock different inodes.
	const holder = dependencies.spawnLock(join(control, "owner.lock"));
	let exited = false;
	const closed = new Promise<void>((resolve) => holder.once("close", () => { exited = true; resolve(); }));
	let diagnostics = "";
	holder.stderr.on("data", (chunk) => { diagnostics += String(chunk).slice(0, 4096 - diagnostics.length); });
	try {
		await new Promise<void>((resolve, reject) => {
			const timeout = dependencies.scheduler.after(2000, () => reject(new Error("Swarm ownership lock did not become ready")));
			const finish = (callback: () => void) => { dependencies.scheduler.cancel(timeout); callback(); };
			let output = "";
			holder.stdout.on("data", (chunk) => {
				output += chunk;
				if (output === "ready") finish(resolve);
			});
			holder.once("error", (error) => finish(() => reject(error)));
			holder.once("close", () => finish(() => reject(new Error(`Swarm ownership unavailable: ${diagnostics.trim()}`))));
		});
		const run = readRun(runId);
		if (dependencies.processExists(run.ownerPid)) throw new Error(`Swarm already has a live owner: ${run.ownerPid}`);
		const token = newToken();
		run.ownerToken = token;
		run.ownerPid = dependencies.pid;
		run.heartbeatAt = dependencies.now();
		run.updatedAt = run.heartbeatAt;
		writeJson(runFile(runId), run);
		let released = false;
		const assertOwned = () => {
			if (released || exited || !holder.pid || !dependencies.processExists(holder.pid)) throw new Error("Swarm ownership lock was lost");
			const current = readRun(runId);
			if (current.ownerToken !== token || current.ownerPid !== dependencies.pid) throw new Error("Swarm root ownership changed");
			return current;
		};
		return {
			token,
			assertOwned,
			heartbeat() {
				const current = assertOwned();
				current.heartbeatAt = dependencies.now();
				current.updatedAt = current.heartbeatAt;
				writeJson(runFile(runId), current);
			},
			async release() {
				if (released) return;
				try {
					const current = assertOwned();
					current.ownerPid = 0;
					writeJson(runFile(runId), current);
				} finally {
					released = true;
					holder.stdin.end();
					await closed;
				}
			},
		};
	} catch (error) {
		holder.stdin.end();
		await closed;
		throw error;
	}
}
