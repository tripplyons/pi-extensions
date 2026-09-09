import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { HOST_RELEASE, codeModeHostBinaryName } from "@howaboua/pi-codex-conversion/dist/tools/code-mode/host-assets.js";
import { git } from "./git.ts";
import { ensureDir, newId, readJson, writeJson } from "./state.ts";
import { tmux } from "./tmux.ts";
import type { RunRecord } from "./types.ts";

const liveTest = process.platform === "darwin" && process.env.PI_SWARM_TEST_MODEL && process.env.PI_SWARM_TEST_CODE_HOST ? test : test.skip;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const waitFor = async (ready: () => boolean, timeout = 30000) => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Timed out waiting for the live Pi fixture");
};

liveTest("real Pi tree shows a tmux worker, stops it, and keeps the coordinator alive", async () => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-tui-")));
	const repository = join(directory, "repo");
	const home = join(directory, "home");
	const agent = join(home, ".pi", "agent");
	const state = join(directory, "state");
	for (const path of [repository, agent, state]) ensureDir(path);
	const session = `swarm-ui-${newId("test").slice(-12)}`;
	const marker = join(directory, "spawned.json");
	const stopped = join(directory, "stopped");
	const availability = join(directory, "availability.json");
	let run: RunRecord | null = null;
	try {
		git(repository, ["init", "-b", "main"]);
		git(repository, ["config", "user.name", "Swarm Test"]);
		git(repository, ["config", "user.email", "swarm@example.invalid"]);
		writeFileSync(join(repository, "initial"), "base\n");
		git(repository, ["add", "initial"]); git(repository, ["commit", "-m", "Initialize fixture"]);
		const provider = process.env.PI_SWARM_TEST_MODEL!.split("/")[0];
		const credentials = readJson<Record<string, unknown>>(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json"));
		if (!credentials?.[provider]) throw new Error(`No stored ${provider} credential for live TUI fixture`);
		writeJson(join(agent, "auth.json"), { [provider]: credentials[provider] });
		writeJson(join(agent, "settings.json"), { packages: [fileURLToPath(new URL("../../", import.meta.url))], extensions: [] });
		writeJson(join(agent, "pi-codex-conversion.json"), { executionMode: "code" });
		const suffix = join(HOST_RELEASE, `${process.platform}-${process.arch}`, codeModeHostBinaryName(process.platform));
		for (const path of [join(agent, "cache", "pi-codex-conversion", "code-mode", suffix), join(state, "runtime", suffix)]) {
			ensureDir(dirname(path)); copyFileSync(process.env.PI_SWARM_TEST_CODE_HOST!, path);
		}
		const fixture = join(directory, "fixture.ts");
		writeFileSync(fixture, `
			import { writeFileSync } from "node:fs";
			import { getCodeModeExtensionToolSnapshot } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@howaboua/pi-codex-conversion/dist/code-mode-extension-tools.js")))};
			export default function(pi) {
				let worker; let stale; const checks = [];
				const call = async (name, params, ctx) => JSON.parse(await getCodeModeExtensionToolSnapshot(pi, ctx, true).tools.find(tool => tool.name === name).invoke(params, {extensionContext:ctx}, new AbortController().signal));
				pi.registerCommand("fixture:availability", {handler: async (_, ctx) => {
					const names = getCodeModeExtensionToolSnapshot(pi, ctx, true).tools;
					if (!stale) stale = names.find(tool => tool.name === "subagent");
					let rejected = "";
					if (checks.length && stale && !names.some(tool => tool.name === "subagent")) try { await stale.invoke({task:"Should not run"}, {extensionContext:ctx}, new AbortController().signal); } catch (error) { rejected = String(error); }
					checks.push({available:names.some(tool => tool.name === "subagent"), processAvailable:names.some(tool => tool.name === "subagent_process"), rejected});
					writeFileSync(${JSON.stringify(availability)}, JSON.stringify(checks));
				}});
				pi.registerCommand("fixture:spawn", { handler: async (_, ctx) => {
					worker = await call("swarm_spawn", {role:"worker", task:"Wait for parent instructions. End your turn without invoking any tools or completing. Do not modify files."}, ctx);
					const tree = await call("swarm_tree", {}, ctx);
					writeFileSync(${JSON.stringify(marker)}, JSON.stringify({worker, index:tree.nodes.findIndex(node => node.nodeId === worker.nodeId)}));
				}});
				pi.registerCommand("fixture:stop", { handler: async (_, ctx) => {
					await call("swarm_stop", {nodeId:worker.nodeId}, ctx);
					writeFileSync(${JSON.stringify(stopped)}, "stopped");
				}});
			}
		`);
		const pi = realpathSync(spawnSync("which", ["pi"], { encoding: "utf8" }).stdout.trim());
		const node = realpathSync(spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim());
		const command = ["env", `HOME=${home}`, `PI_CODING_AGENT_DIR=${agent}`, `PI_SWARM_HOME=${state}`, node, pi, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--model", process.env.PI_SWARM_TEST_MODEL!, "--thinking", "low", "--extension", fixture].map(quote).join(" ");
		tmux(["new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", repository, command]);
		const capture = () => tmux(["capture-pane", "-p", "-t", session]).stdout;
		const send = async (text: string) => {
			tmux(["send-keys", "-t", session, "-l", text]);
			await new Promise((resolve) => setTimeout(resolve, 300));
			tmux(["send-keys", "-t", session, "Enter"]);
		};
		await waitFor(() => capture().includes("low"));
		await send("/fixture:availability");
		await waitFor(() => existsSync(availability));
		expect(JSON.parse(readFileSync(availability, "utf8"))[0].available).toBe(true);
		await send("/swarm:start TUI fixture. Wait for the human; do not call tools or change state on your own.");
		await waitFor(() => existsSync(join(state, "runs")) && readdirSync(join(state, "runs")).length === 1);
		const runId = readdirSync(join(state, "runs"))[0];
		run = readJson<RunRecord>(join(state, "runs", runId, "control", "run.json"));
		await send("/fixture:spawn");
		await waitFor(() => existsSync(marker));
		const spawned = JSON.parse(readFileSync(marker, "utf8"));
		await waitFor(() => readJson<{ status: string }>(join(state, "runs", runId, "control", "nodes", `${spawned.worker.nodeId}.json`))?.status === "running");
		await send("/fixture:availability");
		await waitFor(() => JSON.parse(readFileSync(availability, "utf8")).length === 2);
		await send("/swarm:pause");
		await waitFor(() => readJson<{ status: string }>(join(state, "runs", runId, "control", "processes", spawned.worker.nodeId, "status.json"))?.status === "paused");
		await send("/fixture:availability");
		await waitFor(() => JSON.parse(readFileSync(availability, "utf8")).length === 3);
		for (const check of JSON.parse(readFileSync(availability, "utf8")).slice(1)) {
			expect(check.available).toBe(false);
			expect(check.processAvailable).toBe(true);
			expect(check.rejected).toContain("disabled");
		}
		await send("/swarm:resume");
		await waitFor(() => readJson<{ status: string }>(join(state, "runs", runId, "control", "processes", spawned.worker.nodeId, "status.json"))?.status === "running");
		await send("/swarm:tree");
		await waitFor(() => capture().includes("scroll details"));
		for (let index = 0; index < spawned.index; index++) tmux(["send-keys", "-t", session, "j"]);
		await waitFor(() => capture().includes("macos-sandbox-exec"));
		expect(capture()).toContain("process groups only");
		expect(capture()).toContain("pi-swarm/");
		tmux(["resize-window", "-t", session, "-x", "60", "-y", "40"]);
		await waitFor(() => capture().includes("worker"));
		tmux(["send-keys", "-t", session, "Escape"]);
		await waitFor(() => !capture().includes("scroll details"));
		await send("/fixture:stop");
		await waitFor(() => existsSync(stopped));
		expect(tmux(["display-message", "-p", "-t", `${spawned.worker.tmuxSession}:${spawned.worker.tmuxWindow}`, "#{pane_dead}"]).stdout.trim()).toBe("1");
		expect(tmux(["display-message", "-p", "-t", session, "#{pane_dead}"]).stdout.trim()).toBe("0");
		await send("/swarm:clear");
		await waitFor(() => Boolean(readJson<RunRecord>(join(state, "runs", runId, "control", "run.json"))?.clearedAt));
		await waitFor(() => capture().includes("Swarm clear finished"));
		await send("/fixture:availability");
		await waitFor(() => JSON.parse(readFileSync(availability, "utf8")).length === 4);
		expect(JSON.parse(readFileSync(availability, "utf8"))[3].available).toBe(true);
		expect(existsSync(join(state, "runs", runId, "nodes"))).toBe(false);
	} catch (error) {
		throw new Error(`${error}\n${tmux(["capture-pane", "-p", "-t", session], true).stdout}`);
	} finally {
		if (run) {
			const processes = join(state, "runs", run.runId, "control", "processes");
			if (existsSync(processes)) for (const name of readdirSync(processes)) writeJson(join(processes, name, "command.json"), { status: "stopped" });
			await new Promise((resolve) => setTimeout(resolve, 3000));
			tmux(["kill-session", "-t", run.tmuxSession], true);
		}
		tmux(["kill-session", "-t", session], true);
		rmSync(directory, { recursive: true, force: true });
	}
}, 90000);
