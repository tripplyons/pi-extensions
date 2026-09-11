import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commandRun } from "./client.ts";
import { readRun, currentAttempt, terminal, runFile } from "./state.ts";

test.skipIf(process.env.PI_MIXTURE_E2E !== "1")("live background steering, stop, ownership resume, restart and retained artifacts", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "mixture-e2e-"));
	execFileSync("git", ["init", "-q", cwd]);
	execFileSync("git", ["-C", cwd, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "init"]);
	const options = {
		task: "First run a shell sleep for 5 seconds. Then create answer.txt containing exactly 391 followed by a newline. Reply with 391. Do not commit.",
		models: ["openrouter/z-ai/glm-5.3-flash", "openrouter/z-ai/glm-5.3-flash"], timeoutMs: 90000, thinking: "high", cwd,
	};
	// The launching process exits before this test manages its surviving workers.
	const script = `import { startRun } from ${JSON.stringify(new URL("./client.ts", import.meta.url).href)};
console.log(JSON.stringify(startRun(${JSON.stringify(options)}, "e2e-root")));`;
	const run = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10000 }));
	console.log(`Live mixture state: ${runFile(run.id)}`);
	const attempt = () => currentAttempt(readRun(run.id).workers[0]);
	const until = async (check: () => boolean) => {
		const deadline = Date.now() + 95000;
		while (!check()) {
			if (Date.now() > deadline) throw new Error(`Timed out; inspect ${runFile(run.id)}`);
			await Bun.sleep(100);
		}
	};
	const command = async (owner: string, action: "send" | "stop" | "restart" | "resume", workerId?: string, message?: string) => {
		const request = commandRun(run.id, owner, action, workerId, message);
		await until(() => readRun(run.id).commands.some((item) => item.id === request.requestId && item.status !== "pending"));
		expect(readRun(run.id).commands.find((item) => item.id === request.requestId)?.status).toBe("accepted");
	};
	try {
		expect(run.workers[0].attempts).toHaveLength(0);
		await until(() => attempt()?.status === "running");
		await until(() => readRun(run.id).workers.every((worker) => currentAttempt(worker)?.status === "running"));
		expect(new Set(readRun(run.id).workers.map((worker) => currentAttempt(worker).pid)).size).toBe(2);
		await command("e2e-root", "send", "slot-0", "Keep the answer file uncommitted.");
		const pid = attempt().pid!;
		await command("e2e-root", "stop");
		await until(() => attempt().status === "stopped");
		await until(() => readRun(run.id).workers.every((worker) => currentAttempt(worker).status === "stopped"));
		expect(() => process.kill(pid, 0)).toThrow();
		await command("e2e-reconnected", "resume");
		expect(readRun(run.id).ownerSession).toBe("e2e-reconnected");
		await command("e2e-reconnected", "restart", "slot-0");
		await until(() => attempt().attempt === 2 && terminal(attempt().status));
		const worker = readRun(run.id).workers[0];
		expect(worker.attempts.map((item) => item.status)).toEqual(["stopped", "ok"]);
		expect(attempt().output).toContain("391");
		expect(attempt().usage.input + attempt().usage.output).toBeGreaterThan(0);
		expect(existsSync(attempt().sessionFile)).toBe(true);
		expect(readFileSync(attempt().logFile, "utf8")).toContain("agent_settled");
		expect(readFileSync(join(worker.cwd, "answer.txt"), "utf8")).toBe("391\n");
		expect(worker.changes).toContain("?? answer.txt");
		expect(existsSync(join(cwd, "answer.txt"))).toBe(false);
		expect(execFileSync("git", ["-C", cwd, "branch", "--list", worker.branch!], { encoding: "utf8" })).toContain(worker.branch!);
	} finally {
		if (attempt() && !terminal(attempt().status)) commandRun(run.id, readRun(run.id).ownerSession, "stop");
	}
}, 180000);
