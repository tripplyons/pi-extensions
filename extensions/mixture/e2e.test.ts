import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultConfig } from "./config.ts";
import { runMixture } from "./runner.ts";

const E2E = process.env.PI_MIXTURE_E2E === "1";

describe("mixture e2e", () => {
	test.skipIf(!E2E)("three default models answer in isolated worktrees", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mixture-e2e-"));
		execFileSync("git", ["init", "-q", cwd]);
		execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
		execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
		execFileSync("git", ["-C", cwd, "commit", "-q", "--allow-empty", "-m", "init"]);

		const models = defaultConfig().models;
		const runId = `mix_e2e_${Date.now().toString(36)}`;
		const results = await runMixture(
			{
				task: "Create a file slugify.ts in the working directory that exports a function slugify(input: string): string converting text to a URL slug (lowercase, non-alphanumeric runs become single hyphens, trim leading/trailing hyphens). Reply with the full file contents.",
				models,
				timeoutMs: 10 * 60_000,
				thinking: "high",
				cwd,
			},
			{ runId },
		);

		expect(results.map((result) => result.model)).toEqual(models);
		for (const result of results) {
			expect(result.status).toBe("ok");
			expect(result.output.length).toBeGreaterThan(0);
			expect(result.branch).toBe(`pi-mixture/${runId}/slot-${results.indexOf(result)}`);
		}
		const status = execFileSync("git", ["-C", cwd, "status", "--porcelain"]).toString();
		expect(status.trim()).toBe("");
	}, 600_000);
});
