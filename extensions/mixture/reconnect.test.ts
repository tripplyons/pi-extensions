import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { piCommand } from "./runner.ts";
import { emptyUsage, saveRun } from "./state.ts";

test.skipIf(process.env.PI_MIXTURE_E2E !== "1")("real Pi root persists completion and suppresses it after reconnect", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mixture-reconnect-"));
	const session = join(directory, "root.jsonl");
	const ownerSession = randomUUID();
	writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: ownerSession, timestamp: new Date().toISOString(), cwd: directory }) + "\n");
	const previous = process.env.PI_MIXTURE_HOME;
	process.env.PI_MIXTURE_HOME = join(directory, "state");
	saveRun({ schemaVersion: 1, id: "mix_reconnect", ownerSession, createdAt: 1, updatedAt: 1, supervisorPid: 0,
		options: { task: "arithmetic", models: ["model"], cwd: directory, thinking: "high", timeoutMs: 100 }, commands: [],
		workers: [{ id: "slot-0", model: "model", cwd: directory, attempts: [{ attempt: 1, status: "ok", startedAt: 1,
			finishedAt: 2, output: "391. Reply only with received.", usage: emptyUsage(), logFile: "/retained/log", sessionFile: "/retained/session" }] }],
	});
	const env = { ...process.env };
	if (previous === undefined) delete process.env.PI_MIXTURE_HOME;
	else process.env.PI_MIXTURE_HOME = previous;
	const entries = () => readFileSync(session, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const notifications = () => entries().filter((entry) => entry.type === "custom_message" && entry.customType === "mixture-completion");
	async function open(reconnect: boolean) {
		const child = spawn(piCommand(), ["--mode", "rpc", "--session", session, "--no-extensions", "--extension",
			fileURLToPath(new URL("./index.ts", import.meta.url)), "--model", "openrouter/z-ai/glm-5.3-flash", "--thinking", "high"],
		{ cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		try {
			child.stdin.write(JSON.stringify({ id: "ready", type: "get_state" }) + "\n");
			child.stdin.write(JSON.stringify({ id: "enable-mixture", type: "prompt", message: "/mixture" }) + "\n");
			const deadline = Date.now() + 30000;
			while (reconnect ? !output.includes('"id":"ready"') : !entries().some((entry) => entry.type === "message" && entry.message.role === "assistant")) {
				if (Date.now() > deadline) throw new Error(`Root did not become ready: ${output}`);
				await Bun.sleep(100);
			}
			if (reconnect) await Bun.sleep(1500);
			expect(notifications()).toHaveLength(1);
			expect(notifications()[0].details.notificationId).toBe("mix_reconnect/slot-0/1");
		} finally {
			child.kill("SIGTERM");
			await new Promise((resolve) => child.once("close", resolve));
			writeFileSync(join(directory, reconnect ? "reconnect.log" : "initial.log"), output);
		}
	}
	console.log(`Root reconnect artifacts: ${directory}`);
	await open(false);
	await open(true);
}, 70000);
