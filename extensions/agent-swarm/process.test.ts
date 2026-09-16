import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionMixtureWorker, resolveMixtureWorker } from "./mixture-worker.ts";
import { createWorkerProcesses, inheritedFastEnvironment, workerExtensionArguments, workerPath } from "./process.ts";
import { makeNode } from "./runtime.ts";
import { configPath, defaultConfig } from "../mixture/config.ts";
import { ensureDir, inboxDir, nodeFile, outboxDir, readNode, runDir, runFile, tokenFile, workerHome, workerTmp, writeJson } from "./state.ts";
import { defaultConfig as defaultSwarmConfig } from "./types.ts";

test("worker launch environment preserves enabled and disabled fast mode", () => {
	expect(inheritedFastEnvironment(true)).toBe("1");
	expect(inheritedFastEnvironment(false)).toBe("0");
});

test("worker PATH retains host tool directories after required executable directories", () => {
	expect(workerPath(["/node/bin/node", "/opt/homebrew/Cellar/git/bin/git", "/opt/homebrew/Cellar/tmux/bin/tmux"],
		"/opt/homebrew/bin:/custom/bin:/node/bin::.:relative/bin")).toBe(
		"/node/bin:/opt/homebrew/Cellar/git/bin:/opt/homebrew/Cellar/tmux/bin:/opt/homebrew/bin:/custom/bin:/usr/bin:/bin:/usr/sbin:/sbin");
	expect(workerPath(["/node/bin/node"], "")).toBe("/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
});

function launchFixture(repository: string, runId: string, nodeId: string, model: string) {
	const info = { root: repository, commonDir: join(repository, ".git") };
	const node = makeNode(runId, nodeId, "worker", "Launch fixture", repository, "node_root");
	node.model = model; node.thinking = "low";
	const run = {
		schemaVersion: 2, runId, rootNodeId: "node_root", rootSessionId: `session-${runId}`, ownerToken: "owner-token", cwd: repository,
		gitRoot: info.root, gitCommonDir: info.commonDir, tmuxSession: `tmux-${runId}`, ownerPid: process.pid, heartbeatAt: Date.now(),
		createdAt: Date.now(), updatedAt: Date.now(), status: "active", config: structuredClone(defaultSwarmConfig),
	};
	writeJson(runFile(runId), run);
	writeJson(nodeFile(runId, nodeId), node);
	writeJson(tokenFile(runId, nodeId), "worker-token");
	for (const path of [workerHome(runId, nodeId), workerTmp(runId, nodeId), outboxDir(runId, nodeId), inboxDir(runId, nodeId)]) ensureDir(path);
	return { run, node };
}

function launchDependencies(calls: string[][]) {
	return {
		assertSandboxAvailable: () => {},
		findExecutable: (name: string) => `/fixture/bin/${name}`,
		tmux: (args: string[]) => { calls.push(args); return { ok: true, stdout: "", stderr: "" }; },
		sessionExists: () => false,
		windowExists: () => false,
	};
}

test("createWorkerProcesses provisions Mixture launch arguments and private files without changing ordinary launches", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-process-launch-"));
	const repository = join(root, "repository"); const source = join(root, "agent"); const state = join(root, "state");
	mkdirSync(repository); mkdirSync(source); mkdirSync(state);
	const previousAgent = process.env.PI_CODING_AGENT_DIR; const previousHome = process.env.PI_SWARM_HOME;
	process.env.PI_CODING_AGENT_DIR = source; process.env.PI_SWARM_HOME = state;
	try {
		writeFileSync(join(repository, "initial"), "base\n");
		const preset = structuredClone(defaultConfig().presets.default);
		preset.lead = "fixture/lead"; preset.writer.model = "openrouter/vendor/writer";
		preset.reviewers = [{ model: "fixture/reviewer", thinking: "low" }, { model: "openrouter/vendor/reviewer", thinking: "low" }];
		writeFileSync(join(source, "mixture.json"), JSON.stringify({ version: 3, presets: { selected: preset, unrelated: preset } }));
		writeFileSync(join(source, "auth.json"), JSON.stringify({ fixture: { token: "fixture" }, openrouter: { token: "router" }, anthropic: { token: "unrelated" } }));
		const calls: string[][] = [];
		const processes = createWorkerProcesses(fileURLToPath(new URL("./index.ts", import.meta.url)), launchDependencies(calls));
		const mixtureFixture = launchFixture(repository, "run_mixtureLaunch", "node_mixture", "mixture/selected");
		await processes.start(mixtureFixture.run as any, mixtureFixture.node);
		const mixtureAgent = join(workerHome(mixtureFixture.run.runId, mixtureFixture.node.nodeId), ".pi", "agent");
		const mixtureControl = join(runDir(mixtureFixture.run.runId), "control", "processes", mixtureFixture.node.nodeId);
		const mixtureLaunch = JSON.parse(readFileSync(join(mixtureControl, "launch.json"), "utf8"));
		const mixtureExtension = realpathSync(fileURLToPath(new URL("../mixture/index.ts", import.meta.url)));
		expect(mixtureLaunch.args[mixtureLaunch.args.indexOf("--model") + 1]).toBe("mixture/selected");
		expect(mixtureLaunch.args.filter((value: string) => value === mixtureExtension)).toHaveLength(1);
		expect(mixtureLaunch.args.filter((value: string) => value === "--extension")).toHaveLength(5);
		expect(mixtureLaunch.environment.PI_CODING_AGENT_DIR).toBe(mixtureAgent);
		expect(JSON.parse(readFileSync(join(mixtureAgent, "auth.json"), "utf8"))).toEqual({ fixture: { token: "fixture" }, openrouter: { token: "router" } });
		const privateConfig = JSON.parse(readFileSync(join(mixtureAgent, "mixture.json"), "utf8"));
		expect(Object.keys(privateConfig.presets)).toEqual(["selected"]);
		expect(JSON.stringify(privateConfig)).not.toContain("unrelated");
		expect(calls).toHaveLength(2);

		const ordinaryFixture = launchFixture(repository, "run_ordinaryLaunch", "node_ordinary", "fixture/model");
		await processes.start(ordinaryFixture.run as any, ordinaryFixture.node);
		const ordinaryAgent = join(workerHome(ordinaryFixture.run.runId, ordinaryFixture.node.nodeId), ".pi", "agent");
		const ordinaryControl = join(runDir(ordinaryFixture.run.runId), "control", "processes", ordinaryFixture.node.nodeId);
		const ordinaryLaunch = JSON.parse(readFileSync(join(ordinaryControl, "launch.json"), "utf8"));
		expect(ordinaryLaunch.args[ordinaryLaunch.args.indexOf("--model") + 1]).toBe("fixture/model");
		expect(ordinaryLaunch.args).not.toContain(mixtureExtension);
		expect(existsSync(join(ordinaryAgent, "mixture.json"))).toBe(false);
		expect(JSON.parse(readFileSync(join(ordinaryAgent, "auth.json"), "utf8"))).toEqual({ fixture: { token: "fixture" } });
	} finally {
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
});

test("createWorkerProcesses rejects missing Mixture role credentials before any tmux launch", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-process-missing-"));
	const repository = join(root, "repository"); const source = join(root, "agent"); const state = join(root, "state");
	mkdirSync(repository); mkdirSync(source); mkdirSync(state);
	const previousAgent = process.env.PI_CODING_AGENT_DIR; const previousHome = process.env.PI_SWARM_HOME;
	process.env.PI_CODING_AGENT_DIR = source; process.env.PI_SWARM_HOME = state;
	try {
		writeFileSync(join(repository, "initial"), "base\n");
		const preset = structuredClone(defaultConfig().presets.default); preset.lead = "fixture/lead"; preset.writer.model = "openrouter/vendor/writer"; preset.reviewers = [];
		writeFileSync(join(source, "mixture.json"), JSON.stringify({ version: 3, presets: { selected: preset } }));
		writeFileSync(join(source, "auth.json"), JSON.stringify({ fixture: { token: "fixture" } }));
		const calls: string[][] = [];
		const processes = createWorkerProcesses(fileURLToPath(new URL("./index.ts", import.meta.url)), launchDependencies(calls));
		const fixture = launchFixture(repository, "run_missingLaunch", "node_missing", "mixture/selected");
		await expect(processes.start(fixture.run as any, fixture.node)).rejects.toThrow("openrouter");
		expect(calls).toHaveLength(0);
		expect(existsSync(join(runDir(fixture.run.runId), "control", "processes", fixture.node.nodeId, "launch.json"))).toBe(false);
	} finally {
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Mixture worker provisioning selects one preset and deduplicates required role credentials", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-mixture-provision-"));
	const source = join(root, "source"); const worker = join(root, "worker");
	mkdirSync(source); mkdirSync(worker);
	try {
		const selected = structuredClone(defaultConfig().presets.default);
		selected.lead = "openai-codex/lead";
		selected.writer.model = "openrouter/vendor/writer";
		selected.reviewers = [
			{ model: "openrouter/vendor/reviewer", thinking: "low" },
			{ model: "openai-codex/reviewer", thinking: "low" },
		];
		const other = structuredClone(selected); other.lead = "anthropic/unused";
		writeFileSync(join(source, "mixture.json"), JSON.stringify({ version: 3, presets: { selected, other } }));
		writeFileSync(join(source, "auth.json"), JSON.stringify({
			"openai-codex": { token: "codex" }, openrouter: { token: "router" }, anthropic: { token: "unrelated" },
		}));
		writeFileSync(join(source, "models.json"), `{
			// Keep only selected provider metadata.
			"providers": {
				"openrouter": { "api": "openai-completions", "models": [] },
				"anthropic": { "apiKey": "unrelated-secret", "models": [] }
			}
		}`);

		const setup = provisionMixtureWorker("mixture/selected", source, worker)!;
		expect(setup.providers).toEqual(["openai-codex", "openrouter"]);
		expect(JSON.parse(readFileSync(join(worker, "auth.json"), "utf8"))).toEqual({
			"openai-codex": { token: "codex" }, openrouter: { token: "router" },
		});
		const privateConfig = JSON.parse(readFileSync(join(worker, "mixture.json"), "utf8"));
		expect(Object.keys(privateConfig.presets)).toEqual(["selected"]);
		expect(privateConfig.presets.selected.writer.model).toBe("openrouter/vendor/writer");
		expect(JSON.stringify(privateConfig)).not.toContain("unused");
		const privateModels = JSON.parse(readFileSync(join(worker, "models.json"), "utf8"));
		expect(Object.keys(privateModels.providers)).toEqual(["openrouter"]);
		expect(JSON.stringify(privateModels)).not.toContain("unrelated");
		expect(resolveMixtureWorker("openai-codex/lead", source)).toBeUndefined();
		const ordinaryExtensions = workerExtensionArguments(join(process.cwd(), "extensions/agent-swarm/index.ts"), false);
		const mixtureExtensions = workerExtensionArguments(join(process.cwd(), "extensions/agent-swarm/index.ts"), true);
		expect(ordinaryExtensions).not.toContain(join(process.cwd(), "extensions/mixture/index.ts"));
		expect(mixtureExtensions).toContain(join(process.cwd(), "extensions/mixture/index.ts"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Mixture worker provisioning materializes the default roster when its config is absent", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-mixture-default-"));
	const source = join(root, "source"); const worker = join(root, "worker");
	mkdirSync(source); mkdirSync(worker);
	try {
		writeFileSync(join(source, "auth.json"), JSON.stringify({ "openai-codex": { token: "codex" }, openrouter: { token: "router" } }));
		const setup = provisionMixtureWorker("mixture/default", source, worker)!;
		expect(setup.presetName).toBe("default");
		expect(JSON.parse(readFileSync(join(worker, "mixture.json"), "utf8")).presets.default).toEqual(setup.preset);
		expect(existsSync(join(source, "mixture.json"))).toBe(false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [name, setup] of [
	["invalid configuration", (source: string) => writeFileSync(join(source, "mixture.json"), '{"models":["old/model"]}')],
	["unknown preset", (source: string) => writeFileSync(join(source, "mixture.json"), JSON.stringify({ version: 3, presets: { other: defaultConfig().presets.default } }))],
] as const) test(`Mixture worker provisioning rejects ${name} before writing worker credentials`, () => {
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-mixture-reject-"));
	const source = join(root, "source"); const worker = join(root, "worker");
	mkdirSync(source); mkdirSync(worker);
	try {
		writeFileSync(join(source, "auth.json"), JSON.stringify({ "openai-codex": { token: "codex" }, openrouter: { token: "router" } }));
		setup(source);
		expect(() => provisionMixtureWorker("mixture/default", source, worker)).toThrow(name === "unknown preset" ? "Unknown Mixture preset" : configPath(source));
		expect(existsSync(join(worker, "auth.json"))).toBe(false);
		expect(existsSync(join(worker, "mixture.json"))).toBe(false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("Mixture worker provisioning reports every missing role provider before launch", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-swarm-mixture-missing-"));
	const source = join(root, "source"); const worker = join(root, "worker");
	mkdirSync(source); mkdirSync(worker);
	try {
		const preset = structuredClone(defaultConfig().presets.default);
		preset.lead = "openai-codex/lead"; preset.writer.model = "openrouter/vendor/writer"; preset.reviewers = [{ model: "anthropic/reviewer", thinking: "low" }];
		writeFileSync(join(source, "mixture.json"), JSON.stringify({ version: 3, presets: { default: preset } }));
		writeFileSync(join(source, "auth.json"), JSON.stringify({ "openai-codex": { token: "codex" } }));
		expect(() => provisionMixtureWorker("mixture/default", source, worker)).toThrow("openrouter, anthropic");
		expect(existsSync(join(worker, "auth.json"))).toBe(false);
		expect(existsSync(join(worker, "mixture.json"))).toBe(false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
