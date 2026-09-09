import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeJson } from "./state.ts";
import { SCHEMA_VERSION } from "./types.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (process.platform !== "darwin") throw new Error("Swarm supervisor requires macOS sandbox-exec");
if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000) throw new Error("Invalid supervisor timeout");
if (!Array.isArray(config.args) || !config.args.every((value) => typeof value === "string")) throw new Error("Invalid supervisor arguments");

const child = spawn("/usr/bin/sandbox-exec", ["-f", config.profile, config.executable, ...config.args], {
	cwd: config.cwd, env: config.environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
});
const record = {
	schemaVersion: SCHEMA_VERSION, supervisorPid: process.pid, pid: child.pid ?? null,
	status: "starting", elapsedMs: 0, updatedAt: Date.now(), exitCode: null, signal: null, failure: null,
};
let previousTick = performance.now();
let stoppingAt = null;
let childExited = false;
let timer;

function signalGroup(signal) {
	if (!child.pid) return;
	try { process.kill(-child.pid, signal); }
	catch (error) { if (error.code !== "ESRCH") throw error; }
}

function save() {
	record.updatedAt = Date.now();
	try { writeJson(config.statusFile, record); }
	catch (error) { signalGroup("SIGKILL"); throw error; }
}

function stop(status) {
	if (stoppingAt !== null) return;
	if (record.status === "paused") signalGroup("SIGCONT");
	record.status = status;
	stoppingAt = performance.now();
	signalGroup("SIGTERM");
	save();
}

function finish() {
	clearInterval(timer);
	signalGroup("SIGKILL");
	if (record.status !== "timed-out" && record.status !== "failed") record.status = "exited";
	save();
	// Detached descendants may retain inherited pipes; lifecycle control is group-only.
	child.stdout.destroy();
	child.stderr.destroy();
}

for (const stream of [child.stdout, child.stderr]) {
	stream.on("data", (chunk) => process.stdout.write(chunk.toString().replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")));
}
child.once("spawn", () => { record.status = "running"; save(); });
child.once("error", (error) => { record.failure = error.message; record.status = "failed"; childExited = true; stop("failed"); });
child.once("exit", (code, signal) => {
	childExited = true;
	record.exitCode = code;
	record.signal = signal;
	stop(record.status === "timed-out" ? "timed-out" : "stopping");
});

process.on("SIGTERM", () => stop("stopping"));
process.on("SIGINT", () => stop("stopping"));
timer = setInterval(() => {
	try {
		const tick = performance.now();
		if (stoppingAt !== null) {
			if (tick - stoppingAt >= 1000) {
				signalGroup("SIGKILL");
				if (childExited) finish();
			}
			return;
		}
		if (record.status !== "paused") record.elapsedMs += tick - previousTick;
		previousTick = tick;
		let command;
		try { command = JSON.parse(readFileSync(config.commandFile, "utf8")); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
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
}, 100);
save();
