import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const piBinary = process.env.PI_BIN ?? "pi";

const commandAvailable = (command: string, args: string[]) => {
	try {
		const result = spawnSync(command, args, { encoding: "utf8", timeout: 3_000 });
		return result.error === undefined && result.status === 0;
	} catch {
		return false;
	}
};

const unavailable: string[] = [];
if (process.env.PI_AGENT_SWARM_SKIP_REAL_PI === "1") unavailable.push("PI_AGENT_SWARM_SKIP_REAL_PI=1");
if (!commandAvailable("tmux", ["-V"])) unavailable.push("tmux");
if (!commandAvailable(piBinary, ["--version"])) unavailable.push(`Pi (${piBinary})`);

const runTmux = (...args: string[]) => spawnSync("tmux", args, { encoding: "utf8", timeout: 5_000 });

const capturePane = (session: string) => {
	const result = runTmux("capture-pane", "-p", "-J", "-t", session, "-S", "-120");
	return result.status === 0 ? result.stdout : "";
};

const paneAlive = (session: string) => {
	const result = runTmux("list-panes", "-t", session, "-F", "#{pane_dead}");
	return result.status === 0 && result.stdout.trim().split(/\s+/).some((value) => value === "0");
};

const waitForPane = async (session: string, predicate: (output: string) => boolean, timeoutMs: number) => {
	const deadline = Date.now() + timeoutMs;
	let output = "";
	while (Date.now() < deadline) {
		output = capturePane(session);
		if (predicate(output)) return output;
		await Bun.sleep(100);
	}
	throw new Error(`Timed out waiting for Pi pane output:\n${output}`);
};

const assertNoUncaughtException = (output: string) => {
	expect(output).not.toMatch(/uncaught exception|fatal error|typeerror:|referenceerror:|syntaxerror:/i);
};

const smokeTest = unavailable.length === 0 ? test : test.skip;

smokeTest(`real Pi root session resume reconnects its swarm${unavailable.length > 0 ? ` (skipped: ${unavailable.join(", ")})` : ""}`, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-swarm-real-resume-"));
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	const sessions = join(root, "sessions");
	const swarmState = join(root, "swarm");
	const sessionId = randomUUID();
	const sessionFile = join(sessions, "root.jsonl");
	const tmuxSession = `pi-swarm-resume-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	mkdirSync(sessions, { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: root })}\n`);
	const env = [
		"PI_OFFLINE=1",
		`PI_SWARM_HOME=${swarmState}`,
		"PI_SWARM_WORKER=0",
		"PI_SWARM_RUN_ID=",
		"PI_SWARM_NODE_ID=",
		"PI_SWARM_PARENT_ID=",
		`HOME=${home}`,
		`XDG_CONFIG_HOME=${config}`,
		`XDG_STATE_HOME=${state}`,
		"TERM=xterm-256color",
	];
	const startPi = () => runTmux(
		"new-session", "-d", "-x", "120", "-y", "40", "-s", tmuxSession, "-n", "pi", "-c", root,
		"env", ...env, piBinary,
		"--no-extensions", "--no-skills", "--no-context-files", "--no-approve", "--offline",
		"--session-dir", sessions, "--session", sessionFile, "--extension", extensionPath,
	);
	try {
		expect(startPi().status).toBe(0);
		await waitForPane(tmuxSession, (output) => output.includes("pi v"), 20_000);
		expect(runTmux("send-keys", "-t", tmuxSession, "/swarm:start root resume smoke", "Enter").status).toBe(0);
		await waitForPane(tmuxSession, (output) => output.includes("Swarm root active:"), 15_000);
		const index = JSON.parse(readFileSync(join(swarmState, "sessions", `${sessionId}.json`), "utf8"));
		const runFile = join(swarmState, "runs", index.runId, "run.json");
		const originalOwnerToken = JSON.parse(readFileSync(runFile, "utf8")).rootOwnerToken;

		expect(runTmux("send-keys", "-t", tmuxSession, "/quit", "Enter").status).toBe(0);
		const exitDeadline = Date.now() + 10_000;
		while (Date.now() < exitDeadline && runTmux("has-session", "-t", tmuxSession).status === 0) await Bun.sleep(100);
		expect(runTmux("has-session", "-t", tmuxSession).status).not.toBe(0);

		expect(startPi().status).toBe(0);
		const reconnected = await waitForPane(tmuxSession, (output) => output.includes(`swarm ${index.nodeId.slice(-8)}`), 20_000);
		assertNoUncaughtException(reconnected);
		expect(JSON.parse(readFileSync(runFile, "utf8")).rootOwnerToken).not.toBe(originalOwnerToken);
		expect(runTmux("send-keys", "-t", tmuxSession, "/swarm:tree", "Enter").status).toBe(0);
		const tree = await waitForPane(tmuxSession, (output) => output.includes("Swarm tree") && output.includes(index.nodeId), 10_000);
		assertNoUncaughtException(tree);
	} finally {
		runTmux("kill-session", "-t", tmuxSession);
		rmSync(root, { recursive: true, force: true });
	}
});

smokeTest(`real Pi /swarm:tree TUI smoke${unavailable.length > 0 ? ` (skipped: ${unavailable.join(", ")})` : ""}`, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-swarm-real-tui-"));
	const project = root;
	const home = join(root, "home");
	const config = join(root, "config");
	const state = join(root, "state");
	const sessions = join(root, "sessions");
	const swarmState = join(root, "swarm");
	const session = `pi-swarm-tui-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		const env = [
			`PI_OFFLINE=1`,
			`PI_SWARM_HOME=${swarmState}`,
			`PI_SWARM_WORKER=0`,
			`PI_SWARM_RUN_ID=`,
			`PI_SWARM_NODE_ID=`,
			`PI_SWARM_PARENT_ID=`,
			`HOME=${home}`,
			`XDG_CONFIG_HOME=${config}`,
			`XDG_STATE_HOME=${state}`,
			`TERM=xterm-256color`,
		];
		const started = runTmux(
			"new-session", "-d", "-x", "120", "-y", "40", "-s", session, "-n", "pi", "-c", project,
			"env", ...env, piBinary,
			"--no-extensions", "--no-skills", "--no-context-files", "--no-approve", "--offline",
			"--session-dir", sessions, "--session-id", "agent-swarm-tui-smoke", "--extension", extensionPath,
		);
		expect(started.status).toBe(0);
		await waitForPane(session, (output) => output.includes("pi v"), 20_000);
		assertNoUncaughtException(capturePane(session));

		expect(runTmux("send-keys", "-t", session, "/swarm:start TUI smoke", "Enter").status).toBe(0);
		await waitForPane(session, (output) => output.includes("Swarm root active:"), 15_000);
		assertNoUncaughtException(capturePane(session));

		expect(runTmux("send-keys", "-t", session, "/swarm:tree", "Enter").status).toBe(0);
		await waitForPane(session, (output) => output.includes("Swarm tree"), 10_000);
		for (const key of ["j", "k", "Down", "Up"]) {
			expect(runTmux("send-keys", "-t", session, key).status).toBe(0);
			await Bun.sleep(100);
		}
		expect(runTmux("send-keys", "-t", session, "q").status).toBe(0);
		await Bun.sleep(300);

		expect(paneAlive(session)).toBe(true);
		assertNoUncaughtException(capturePane(session));
	} finally {
		runTmux("kill-session", "-t", session);
		rmSync(root, { recursive: true, force: true });
	}
});
