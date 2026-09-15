import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, defaultConfig, loadConfig, parseConfig, saveConfig, splitModel } from "./config.ts";

const directories: string[] = [];
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), "mixture-config-")); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("missing config uses the selected roster without writing", () => {
	const dir = temporary();
	const config = loadConfig(dir);
	expect(config).toEqual(defaultConfig());
	expect(config.presets.default.reviewers).toHaveLength(1);
	expect(existsSync(configPath(dir))).toBe(false);
	config.presets.default.reviewers.length = 0;
	expect(defaultConfig().presets.default.reviewers).toHaveLength(1);
});
test("strict versioned config rejects old schema, recursion, unsafe names, and limits", () => {
	for (const change of [
		() => ({ models: ["x/y"] }),
		() => [],
		() => ({ ...defaultConfig(), credentials: "no" }),
		() => ({ ...defaultConfig(), presets: {} }),
		() => ({ ...defaultConfig(), presets: { "../bad": defaultConfig().presets.default } }),
		() => ({ ...defaultConfig(), presets: { default: { ...defaultConfig().presets.default, lead: "mixture/default" } } }),
		() => ({ ...defaultConfig(), presets: { default: { ...defaultConfig().presets.default, limits: { requestTimeoutMs: 0 } } } }),
		() => ({ ...defaultConfig(), presets: { default: { ...defaultConfig().presets.default, limits: { writerRequestTimeoutMs: 600_001 } } } }),
		() => ({ ...defaultConfig(), presets: { default: { ...defaultConfig().presets.default, limits: { writerIdleTimeoutMs: 0 } } } }),
		() => ({ ...defaultConfig(), presets: { default: { ...defaultConfig().presets.default, limits: { delegations: 8 } } } }),
		() => ({ ...defaultConfig(), presets: { default: { ...defaultConfig().presets.default, limits: { reviewerRequests: 24 } } } }),
		() => ({ ...defaultConfig(), presets: { default: { ...defaultConfig().presets.default, limits: { finalCorrections: 2 } } } }),
	]) expect(() => parseConfig(change())).toThrow();
	expect(splitModel("openrouter/deepseek/model")).toEqual(["openrouter", "deepseek/model"]);
	expect(() => splitModel("provider/")).toThrow();
	expect(() => splitModel("no-provider")).toThrow();
});
test("malformed and old files fail with the path and are preserved", () => {
	const dir = temporary();
	const version2 = defaultConfig() as any;
	version2.version = 2;
	for (const text of ["{bad", '{"models":["x/y"]}', JSON.stringify(version2)]) {
		writeFileSync(configPath(dir), text);
		expect(() => loadConfig(dir)).toThrow(configPath(dir));
		expect(readFileSync(configPath(dir), "utf8")).toBe(text);
	}
});
test("saves atomically, fills optional limits, and detects concurrent changes", () => {
	const dir = temporary();
	const config = defaultConfig();
	saveConfig(config, dir, null);
	expect(loadConfig(dir)).toEqual(config);
	const before = readFileSync(configPath(dir), "utf8");
	writeFileSync(configPath(dir), before + "\n");
	expect(() => saveConfig(config, dir, before)).toThrow("changed while editing");
	const sparse = JSON.parse(before);
	delete sparse.presets.default.limits;
	expect(parseConfig(sparse)).toEqual(config);
});
