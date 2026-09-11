import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODELS, DEFAULT_TIMEOUT_MS, configPath, loadConfig } from "./config.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "mixture-config-"));

describe("mixture config", () => {
	test("writes defaults when the file is missing", () => {
		const dir = tempDir();
		const config = loadConfig(dir);
		expect(config.models).toEqual([...DEFAULT_MODELS]);
		expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
		const written = JSON.parse(readFileSync(configPath(dir), "utf8"));
		expect(written.models).toEqual([...DEFAULT_MODELS]);
		expect(written.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
	});

	test("keeps configured models and timeout", () => {
		const dir = tempDir();
		writeFileSync(configPath(dir), JSON.stringify({ models: ["openrouter/foo/bar"], timeoutMs: 1234 }));
		expect(loadConfig(dir)).toEqual({ models: ["openrouter/foo/bar"], timeoutMs: 1234 });
	});

	test("fills missing models with defaults and writes them back", () => {
		const dir = tempDir();
		writeFileSync(configPath(dir), JSON.stringify({ timeoutMs: 5000 }));
		expect(loadConfig(dir)).toEqual({ models: [...DEFAULT_MODELS], timeoutMs: 5000 });
		expect(JSON.parse(readFileSync(configPath(dir), "utf8")).models).toEqual([...DEFAULT_MODELS]);
	});

	test("rejects invalid JSON naming the path", () => {
		const dir = tempDir();
		writeFileSync(configPath(dir), "{nope");
		expect(() => loadConfig(dir)).toThrow(configPath(dir));
	});

	test("rejects bad shapes", () => {
		for (const body of [`[]`, `{"models": []}`, `{"models": ["no-provider"]}`, `{"timeoutMs": -1}`]) {
			const dir = tempDir();
			writeFileSync(configPath(dir), body);
			expect(() => loadConfig(dir)).toThrow(configPath(dir));
		}
	});
});
