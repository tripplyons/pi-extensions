import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "./config.ts";

for (const cli of ["bundled", "node"] as const) test(`real Pi ${cli} CLI discovers a configured Mixture preset without inference`, () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-discovery-"));
	try {
		const config = defaultConfig();
		config.presets.default.lead = "fixture/lead";
		config.presets.default.writer.model = "fixture/writer";
		config.presets.default.reviewers = [{ model: "fixture/reviewer", thinking: "low" }];
		writeFileSync(join(dir, "mixture.json"), JSON.stringify(config));
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
			api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only",
			models: ["lead", "writer", "reviewer"].map(id => ({ id, reasoning: true, contextWindow: 100_000, maxTokens: 20_000 })),
		} } }));
		const before = readFileSync(join(dir, "mixture.json"), "utf8");
		const command = cli === "bundled" ? "pi" : "node";
		const prefix = cli === "bundled" ? [] : [fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url))];
		const result = spawnSync(command, [...prefix, "--no-extensions", "-e", fileURLToPath(new URL("./index.ts", import.meta.url)), "--list-models", "mixture"], {
			cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1" }, encoding: "utf8", timeout: 20_000,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("mixture");
		expect(result.stdout).toContain("default");
		expect(result.stderr).not.toContain("Error");
		expect(readFileSync(join(dir, "mixture.json"), "utf8")).toBe(before);
		expect(readdirSync(dir)).not.toContain("sessions");
	} finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
