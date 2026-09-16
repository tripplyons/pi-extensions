import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { runSupervisor } from "./supervisor.mjs";

class FakeStream extends EventEmitter { destroy() {} }
class FakeChild extends EventEmitter {
	pid = 4100;
	stdout = new FakeStream();
	stderr = new FakeStream();
}

test("supervisor containment signals only the worker process group, not detached descendant groups", () => {
	const child = new FakeChild();
	const detachedDescendantPid = 4200;
	const signals: Array<[number, string]> = [];
	let now = 0;
	const supervisor = runSupervisor({
		profile: "/worker.sb", executable: "/node", args: [], cwd: "/worktree", environment: {},
		timeoutMs: 1_000, statusFile: "/status", commandFile: "/command",
	}, {
		clock: () => now,
		spawn: () => child,
		signal: (pid: number, signal: string) => signals.push([pid, signal]),
		save: () => {}, readCommand: () => undefined, onSignal: () => {}, setInterval: () => 1, output: () => {},
	});
	child.emit("spawn");
	now = 1_001;
	supervisor.tick();
	now = 2_002;
	supervisor.tick();

	expect(signals).toContainEqual([-child.pid, "SIGTERM"]);
	expect(signals).toContainEqual([-child.pid, "SIGKILL"]);
	expect(signals.some(([pid]) => pid === -detachedDescendantPid || pid === detachedDescendantPid)).toBe(false);
});
