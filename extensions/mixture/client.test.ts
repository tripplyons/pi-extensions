import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRun, reconnectRuns, wakeSupervisor } from "./client.ts";
import { emptyUsage, readRun, saveRun, runDir, writeJson, type Run } from "./state.ts";

async function until(check: () => boolean) {
	const deadline = Date.now() + 15000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for supervisor state");
		await Bun.sleep(30);
	}
}

test.skipIf(process.platform !== "darwin")("detached daemon orders mailbox, acknowledges stop-all and wakes after idle exit", async () => {
	const previous = process.env.PI_MIXTURE_HOME;
	const directory = mkdtempSync(join(tmpdir(), "mixture-daemon-"));
	process.env.PI_MIXTURE_HOME = directory;
	const id = "mix_daemontest";
	const run: Run = { schemaVersion: 1, id, ownerSession: "root", createdAt: 1, updatedAt: 1,
		supervisorPid: 0, options: { task: "test", models: [], cwd: directory, timeoutMs: 1000, thinking: "high" },
		workers: [], commands: [] };
	try {
		saveRun(run);
		// Reverse lexical IDs prove creation order rather than filename order.
		writeJson(join(runDir(id), "commands", "cmd_ffff.json"), { id: "cmd_ffff", action: "resume", session: "second", createdAt: 1 });
		writeJson(join(runDir(id), "commands", "cmd_aaaa.json"), { id: "cmd_aaaa", action: "stop", session: "second", createdAt: 2 });
		wakeSupervisor(id);
		await until(() => readRun(id).commands.length === 2);
		expect(readRun(id).commands.map((command) => [command.id, command.status])).toEqual([
			["cmd_ffff", "accepted"], ["cmd_aaaa", "accepted"],
		]);
		expect(readRun(id).ownerSession).toBe("second");
		expect(() => commandRun(id, "root", "stop")).toThrow("another session");
		await until(() => readRun(id).supervisorPid === 0);
		const request = commandRun(id, "second", "stop");
		await until(() => readRun(id).commands.some((command) => command.id === request.requestId));
		expect(readRun(id).commands.at(-1)?.status).toBe("accepted");
		await until(() => readRun(id).supervisorPid === 0);
		const interrupted = readRun(id);
		interrupted.workers.push({ id: "slot-0", model: "model", cwd: directory, attempts: [{
			attempt: 1, status: "running", startedAt: 1, output: "retained partial output",
			usage: { ...emptyUsage(), input: 12 }, logFile: "/retained/events", sessionFile: "/retained/session",
		}] });
		interrupted.commands.push({ id: "cmd_dead", action: "send", workerId: "slot-0", session: "second", message: "steer", createdAt: 3, status: "pending" });
		saveRun(interrupted);
		reconnectRuns("second");
		await until(() => readRun(id).workers[0].attempts[0].status === "failed");
		const recovered = readRun(id);
		expect(recovered.workers[0].attempts[0]).toMatchObject({ output: "retained partial output", usage: { input: 12 } });
		expect(recovered.commands.at(-1)).toMatchObject({ status: "rejected" });
		expect(recovered.commands.at(-1)?.error).toContain("Delivery is unknown");
		await until(() => readRun(id).supervisorPid === 0);
		const invalid = readRun(id);
		invalid.workers.push({ id: "slot-1", model: "openrouter/model", cwd: runDir(id), attempts: [] });
		saveRun(invalid);
		wakeSupervisor(id);
		await until(() => readRun(id).workers[1].attempts[0]?.status === "failed");
		const failure = readRun(id).workers[1].attempts[0];
		expect(failure.error).toContain("preparation failed");
		expect(readFileSync(failure.logFile, "utf8")).toContain("preparation_error");
		await until(() => readRun(id).supervisorPid === 0);
	} finally {
		const pid = readRun(id).supervisorPid;
		if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
		if (previous === undefined) delete process.env.PI_MIXTURE_HOME;
		else process.env.PI_MIXTURE_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	}
}, 20000);
