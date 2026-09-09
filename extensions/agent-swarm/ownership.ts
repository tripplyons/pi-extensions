import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureDir, newToken, readRun, runDir, runFile, writeJson } from "./state.ts";

export function processExists(pid: number) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

export async function acquireRunOwnership(runId: string) {
	if (process.platform !== "darwin") throw new Error("Swarm ownership requires macOS lockf");
	const control = join(runDir(runId), "control");
	ensureDir(control);
	// Keep the inode. Unlinking a flock file allows two owners to lock different inodes.
	const holder = spawn("/usr/bin/lockf", ["-k", "-t", "0", join(control, "owner.lock"), "/bin/sh", "-c", "printf ready; exec /bin/cat >/dev/null"], {
		stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" },
	});
	let exited = false;
	const closed = new Promise<void>((resolve) => holder.once("close", () => { exited = true; resolve(); }));
	let diagnostics = "";
	holder.stderr.on("data", (chunk) => { diagnostics += String(chunk).slice(0, 4096 - diagnostics.length); });
	try {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Swarm ownership lock did not become ready")), 2000);
			let output = "";
			holder.stdout.on("data", (chunk) => {
				output += chunk;
				if (output === "ready") { clearTimeout(timeout); resolve(); }
			});
			holder.once("error", (error) => { clearTimeout(timeout); reject(error); });
			holder.once("close", () => { clearTimeout(timeout); reject(new Error(`Swarm ownership unavailable: ${diagnostics.trim()}`)); });
		});
		const run = readRun(runId);
		if (processExists(run.ownerPid)) throw new Error(`Swarm already has a live owner: ${run.ownerPid}`);
		const token = newToken();
		run.ownerToken = token;
		run.ownerPid = process.pid;
		run.heartbeatAt = Date.now();
		run.updatedAt = run.heartbeatAt;
		writeJson(runFile(runId), run);
		let released = false;
		const assertOwned = () => {
			if (released || exited || !holder.pid || !processExists(holder.pid)) throw new Error("Swarm ownership lock was lost");
			const current = readRun(runId);
			if (current.ownerToken !== token || current.ownerPid !== process.pid) throw new Error("Swarm root ownership changed");
			return current;
		};
		return {
			token,
			assertOwned,
			heartbeat() {
				const current = assertOwned();
				current.heartbeatAt = Date.now();
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
