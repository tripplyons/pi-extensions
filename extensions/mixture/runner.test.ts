import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorker } from "./runner.ts";

test("preparation isolates credentials and retains the real runtime paths", () => {
	const root = mkdtempSync(join(tmpdir(), "mixture-prepare-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const cacheKeys = ["XDG_CACHE_HOME", "PYTHONPYCACHEPREFIX", "UV_CACHE_DIR", "UV_PROJECT_ENVIRONMENT"];
	const previousCaches = cacheKeys.map((key) => process.env[key]);
	for (const key of cacheKeys) process.env[key] = join(root, "host-cache", key);
	process.env.PI_CODING_AGENT_DIR = join(root, "source");
	mkdirSync(process.env.PI_CODING_AGENT_DIR);
	mkdirSync(join(root, "worktree"));
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), JSON.stringify({
		openrouter: { key: "selected" }, anthropic: { key: "unrelated" },
	}));
	try {
		const prepared = prepareWorker("openrouter/model", {
			task: "test", models: ["openrouter/model", "anthropic/model"], cwd: root, timeoutMs: 100, thinking: "high",
		}, { cwd: join(root, "worktree") }, { id: "mix_test", home: join(root, "attempt-1") });
		const agent = prepared.environment.PI_CODING_AGENT_DIR!;
		expect(prepared.environment.PI_BG_BASH_TMUX_SOCKET).toBe(join(prepared.environment.TMPDIR!, "bg.sock"));
		expect(agent.startsWith(prepared.environment.HOME!)).toBe(true);
		expect(JSON.parse(readFileSync(join(agent, "auth.json"), "utf8"))).toEqual({ openrouter: { key: "selected" } });
		expect(statSync(join(agent, "auth.json")).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"))).toEqual({
			packages: [], extensions: [], skills: [], compaction: { enabled: true, reserveTokens: 60000 },
		});
		for (const [key, directory] of Object.entries({
			XDG_CACHE_HOME: "cache", PYTHONPYCACHEPREFIX: "python-bytecode",
			UV_CACHE_DIR: "uv-cache", UV_PROJECT_ENVIRONMENT: "uv-venv",
		})) expect(prepared.environment[key]).toBe(join(prepared.environment.TMPDIR!, directory));
		expect(existsSync(prepared.profile)).toBe(true);
		expect(existsSync(prepared.invocation.command)).toBe(true);
		expect(existsSync(prepared.invocation.conversion)).toBe(true);
		expect(prepared.invocation.conversion).toBe(new URL("../pi-codex-conversion/index.ts", import.meta.url).pathname);
		expect(existsSync(prepared.invocation.bgBash)).toBe(true);
		expect(JSON.parse(readFileSync(join(agent, "pi-codex-conversion.json"), "utf8"))).toEqual({
			executionMode: "normal", voiceFeaturesOnly: true,
			tools: { applyPatchOnly: false, viewImageOnly: false, autoReasoning: false },
			compaction: { contextManagement: "off", hybridCompaction: false, responsesCompaction: false },
			scope: { allProviders: "on" },
		});
		expect(prepared.environment.PATH).toBe(process.env.PATH);
	} finally {
		for (const [index, key] of cacheKeys.entries()) {
			if (previousCaches[index] === undefined) delete process.env[key];
			else process.env[key] = previousCaches[index];
		}
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
