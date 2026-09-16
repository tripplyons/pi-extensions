import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeJson } from "./state.ts";
import { SCHEMA_VERSION } from "./types.ts";

export function validateSupervisorConfig(config, platform = process.platform) {
	if (platform !== "darwin") throw new Error("Swarm supervisor requires macOS sandbox-exec");
	if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000) throw new Error("Invalid supervisor timeout");
	if (!Array.isArray(config.args) || !config.args.every((value) => typeof value === "string")) throw new Error("Invalid supervisor arguments");
}

export function runSupervisor(config, dependencies = {}) {
	const clock = dependencies.clock ?? (() => performance.now());
	const signal = dependencies.signal ?? ((pid, value) => process.kill(pid, value));
	const saveRecord = dependencies.save ?? ((record) => writeJson(config.statusFile, record));
	const readCommand = dependencies.readCommand ?? (() => {
		try { return JSON.parse(readFileSync(config.commandFile, "utf8")); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
	});
	const output = dependencies.output ?? ((chunk) => process.stdout.write(chunk.toString().replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")));
	const child = (dependencies.spawn ?? spawn)("/usr/bin/sandbox-exec", ["-f", config.profile, config.executable, ...config.args], {
		cwd: config.cwd, env: config.environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
	});
	const record = {
		schemaVersion: SCHEMA_VERSION, supervisorPid: dependencies.pid ?? process.pid, pid: child.pid ?? null,
		status: "starting", elapsedMs: 0, updatedAt: Date.now(), exitCode: null, signal: null, failure: null,
	};
	let previousTick = clock();
	let stoppingAt = null;
	let childExited = false;
	let timer;

	function signalGroup(value) {
		if (!child.pid) return;
		try { signal(-child.pid, value); }
		catch (error) { if (error.code !== "ESRCH") throw error; }
	}
	function save() {
		record.updatedAt = Date.now();
		try { saveRecord(structuredClone(record)); }
		catch (error) { signalGroup("SIGKILL"); throw error; }
	}
	function stop(status) {
		if (stoppingAt !== null) return;
		if (record.status === "paused") signalGroup("SIGCONT");
		record.status = status;
		stoppingAt = clock();
		signalGroup("SIGTERM");
		save();
	}
	function finish() {
		if (timer) (dependencies.clearInterval ?? clearInterval)(timer);
		signalGroup("SIGKILL");
		if (record.status !== "timed-out" && record.status !== "failed") record.status = "exited";
		save();
		child.stdout.destroy();
		child.stderr.destroy();
	}
	function tick() {
		try {
			const now = clock();
			if (stoppingAt !== null) {
				if (now - stoppingAt >= 1000) {
					signalGroup("SIGKILL");
					if (childExited) finish();
				}
				return;
			}
			if (record.status !== "paused") record.elapsedMs += now - previousTick;
			previousTick = now;
			const command = readCommand();
			if (command && !["running", "paused", "stopped"].includes(command.status)) throw new Error("Invalid supervisor command");
			if (command?.status === "stopped") { stop("stopping"); return; }
			if (record.elapsedMs >= config.timeoutMs) { stop("timed-out"); return; }
			if (command?.status === "paused" && record.status !== "paused") { signalGroup("SIGSTOP"); record.status = "paused"; }
			if (command?.status === "running" && record.status === "paused") { signalGroup("SIGCONT"); record.status = "running"; }
			save();
		} catch (error) {
			record.failure = error.message;
			stop("failed");
		}
	}

	for (const stream of [child.stdout, child.stderr]) stream.on("data", output);
	child.once("spawn", () => { record.status = "running"; save(); });
	child.once("error", (error) => { record.failure = error.message; record.status = "failed"; childExited = true; stop("failed"); });
	child.once("exit", (code, value) => {
		childExited = true;
		record.exitCode = code;
		record.signal = value;
		stop(record.status === "timed-out" ? "timed-out" : "stopping");
	});
	for (const name of ["SIGTERM", "SIGINT"]) (dependencies.onSignal ?? process.on.bind(process))(name, () => stop("stopping"));
	timer = (dependencies.setInterval ?? setInterval)(tick, 100);
	save();
	return { child, record, tick, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
	validateSupervisorConfig(config);
	runSupervisor(config);
}
