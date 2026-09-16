import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { runSupervisor, validateSupervisorConfig } from "./supervisor.mjs";

class FakeStream extends EventEmitter {
	destroyed = false;
	destroy() { this.destroyed = true; }
}

class FakeChild extends EventEmitter {
	pid = 4321;
	stdout = new FakeStream();
	stderr = new FakeStream();
}

const config = {
	profile: "/state/worker.sb",
	executable: "/usr/bin/node",
	cwd: "/worktree",
	timeoutMs: 1_000,
	statusFile: "/state/status.json",
	commandFile: "/state/command.json",
	environment: { HOME: "/worker/home" },
	args: ["worker.mjs", "--rpc"],
};

test("supervisor validates platform, timeout, and worker arguments before spawning", () => {
	expect(() => validateSupervisorConfig(config, "darwin")).not.toThrow();
	expect(() => validateSupervisorConfig(config, "linux")).toThrow("requires macOS");
	expect(() => validateSupervisorConfig({ ...config, timeoutMs: 999 }, "darwin")).toThrow("timeout");
	expect(() => validateSupervisorConfig({ ...config, args: ["ok", 1] }, "darwin")).toThrow("arguments");
});

test("mocked supervisor pauses elapsed time, resumes, and force-kills after timeout", () => {
	const child = new FakeChild();
	const signals: Array<[number, string]> = [];
	const saves: any[] = [];
	const signalHandlers = new Map<string, Function>();
	let command: { status: string } | undefined;
	let now = 0;
	let spawnCall: any[] | undefined;
	let intervalCleared = false;
	const supervisor = runSupervisor(config, {
		pid: 1234,
		clock: () => now,
		spawn: (...args: any[]) => { spawnCall = args; return child; },
		signal: (pid: number, value: string) => signals.push([pid, value]),
		save: (record: object) => saves.push(record),
		readCommand: () => command,
		onSignal: (name: string, handler: Function) => { signalHandlers.set(name, handler); },
		setInterval: () => ({ fake: true }),
		clearInterval: () => { intervalCleared = true; },
		output: () => {},
	});

	expect(spawnCall?.slice(0, 2)).toEqual([
		"/usr/bin/sandbox-exec",
		["-f", config.profile, config.executable, ...config.args],
	]);
	expect(spawnCall?.[2]).toMatchObject({ cwd: config.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	expect(supervisor.record.status).toBe("starting");
	child.emit("spawn");
	expect(supervisor.record.status).toBe("running");

	now = 100;
	command = { status: "paused" };
	supervisor.tick();
	expect(supervisor.record).toMatchObject({ status: "paused", elapsedMs: 100 });
	expect(signals.at(-1)).toEqual([-child.pid, "SIGSTOP"]);

	now = 1_500;
	supervisor.tick();
	expect(supervisor.record).toMatchObject({ status: "paused", elapsedMs: 100 });
	command = { status: "running" };
	now = 1_600;
	supervisor.tick();
	expect(supervisor.record).toMatchObject({ status: "running", elapsedMs: 100 });
	expect(signals.at(-1)).toEqual([-child.pid, "SIGCONT"]);

	command = undefined;
	now = 2_501;
	supervisor.tick();
	expect(supervisor.record.status).toBe("timed-out");
	expect(signals.at(-1)).toEqual([-child.pid, "SIGTERM"]);
	now = 3_502;
	supervisor.tick();
	expect(signals.at(-1)).toEqual([-child.pid, "SIGKILL"]);
	child.emit("exit", null, "SIGKILL");
	supervisor.tick();
	expect(supervisor.record.status).toBe("timed-out");
	expect(intervalCleared).toBe(true);
	expect(child.stdout.destroyed).toBe(true);
	expect(child.stderr.destroyed).toBe(true);
	expect(saves.at(-1)).toMatchObject({ supervisorPid: 1234, pid: child.pid, status: "timed-out", signal: "SIGKILL" });
	expect([...signalHandlers.keys()]).toEqual(["SIGTERM", "SIGINT"]);
});

test("invalid mocked commands fail closed and terminate the worker group", () => {
	const child = new FakeChild();
	const signals: string[] = [];
	const supervisor = runSupervisor(config, {
		clock: () => 100,
		spawn: () => child,
		signal: (_pid: number, value: string) => signals.push(value),
		save: () => {},
		readCommand: () => ({ status: "forged" }),
		onSignal: () => {},
		setInterval: () => 1,
		output: () => {},
	});
	child.emit("spawn");
	supervisor.tick();
	expect(supervisor.record).toMatchObject({ status: "failed", failure: "Invalid supervisor command" });
	expect(signals).toContain("SIGTERM");
});
