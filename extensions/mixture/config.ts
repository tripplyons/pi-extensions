import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_MODELS = [
	"openrouter/z-ai/glm-5.3-flash",
	"openrouter/deepseek/deepseek-v4.1-flash",
	"openrouter/meta/muse-spark-1.3-contributor",
] as const;

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface MixtureConfig {
	models: string[];
	timeoutMs: number;
}

export const agentDir = (override?: string) =>
	override ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

export const configPath = (dir?: string) => join(agentDir(dir), "mixture.json");

export const defaultConfig = (): MixtureConfig => ({
	models: [...DEFAULT_MODELS],
	timeoutMs: DEFAULT_TIMEOUT_MS,
});

const problems = (value: unknown): string[] => {
	const found: string[] = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return ["config must be a JSON object"];
	}
	const config = value as Record<string, unknown>;
	if (config.models !== undefined) {
		if (!Array.isArray(config.models) || config.models.length === 0) {
			found.push("models must be a non-empty array of provider/model strings");
		} else {
			for (const model of config.models) {
				if (typeof model !== "string" || !model.trim() || !model.includes("/")) {
					found.push(`model ${JSON.stringify(model)} must be a provider/model string`);
				}
			}
		}
	}
	if (config.timeoutMs !== undefined) {
		if (!Number.isInteger(config.timeoutMs) || (config.timeoutMs as number) <= 0) {
			found.push("timeoutMs must be a positive integer");
		}
	}
	return found;
};

export const loadConfig = (dir?: string): MixtureConfig => {
	const path = configPath(dir);
	let raw: string | null = null;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		raw = null;
	}
	if (raw === null) {
		const defaults = defaultConfig();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(defaults, null, 2)}\n`);
		return defaults;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Invalid mixture config at ${path}: not valid JSON`);
	}
	const issues = problems(parsed);
	if (issues.length) throw new Error(`Invalid mixture config at ${path}: ${issues.join("; ")}`);
	const config = parsed as Partial<MixtureConfig>;
	const merged = { ...defaultConfig(), ...config };
	if (config.models === undefined) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
	}
	return merged;
};
