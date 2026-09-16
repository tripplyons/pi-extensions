import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { startAgentRun, type SpawnChild } from "./runner.ts";
import { ManualScheduler } from "../test-scheduler.ts";

function childFixture(pid = 4321) {
	const child = new EventEmitter() as ChildProcess;
	Object.assign(child, {
		pid,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: null,
		unref() {},
		kill() { return true; },
	});
	return child;
}

test("agent runs activate native extensions, parse protocol output, and cancel the child group", async () => {
	const child = childFixture();
	let invocation: { command: string; args: readonly string[]; options: any } | undefined;
	const spawn: SpawnChild = ((command: string, args: readonly string[], options: any) => {
		invocation = { command, args, options };
		return child;
	}) as SpawnChild;
	const signals: Array<[number, NodeJS.Signals]> = [];
	const originalKill = process.kill;
	process.kill = ((pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); return true; }) as typeof process.kill;
	try {
		const run = startAgentRun({ task: "Inspect the checkout", cwd: "/tmp/project", model: "fixture/model", thinking: "low" }, spawn);
		expect(invocation?.args).toContain("--no-extensions");
		expect(invocation?.args.filter(argument => argument === "--extension")).toHaveLength(2);
		expect(invocation?.args).toContain("--model");
		expect(invocation?.args).toContain("fixture/model");
		expect(invocation?.options).toMatchObject({ cwd: "/tmp/project", shell: false, stdio: ["ignore", "pipe", "pipe"] });

		child.stdout!.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "read" })}\n`);
		child.stdout!.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "read" })}\n`);
		child.stdout!.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fixture/model", content: [{ type: "text", text: "done" }], usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.01 } }, stopReason: "stop" } })}\n`);
		child.stderr!.write("diagnostic");
		await Promise.resolve();
		expect(run.snapshot()).toMatchObject({ output: "done", stderr: "diagnostic", completedToolCount: 1, activity: "message_end", usage: { input: 3, output: 2, cacheRead: 1, turns: 1 } });

		const stopped = run.kill();
		expect(signals).toEqual([[process.platform === "win32" ? 4321 : -4321, "SIGTERM"]]);
		child.emit("close", null);
		expect(await stopped).toMatchObject({ status: "killed", reason: "killed" });
	} finally {
		process.kill = originalKill;
	}
});

test("cancellation grace periods escalate and finalize through the injected scheduler", async () => {
	const child = childFixture(9876);
	const spawn = (() => child) as SpawnChild;
	const scheduler = new ManualScheduler();
	const signals: Array<[number, NodeJS.Signals]> = [];
	const originalKill = process.kill;
	process.kill = ((pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); return true; }) as typeof process.kill;
	try {
		const run = startAgentRun({ task: "stuck", cwd: "/tmp", thinking: "off" }, spawn, scheduler);
		const stopped = run.kill();
		expect(signals.map(([, signal]) => signal)).toEqual(["SIGTERM"]);
		await scheduler.advanceBy(2_000);
		expect(signals.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
		await scheduler.advanceBy(2_000);
		expect(await stopped).toMatchObject({ status: "killed", error: "Subagent did not exit after SIGKILL" });
	} finally {
		process.kill = originalKill;
	}
});
