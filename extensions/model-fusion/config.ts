import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Reasoning = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Slot = { provider: string; model: string; reasoning: Reasoning };
export type Config = { actor: Slot; reviewers: Slot[]; frontier: Slot; timeoutMs: number; reviewEveryToolCalls: number };
export const CONFIG_PATH = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "model-fusion.json");
export const DEFAULT_CONFIG: Config = {
	actor: { provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "max" },
	reviewers: [
		{ provider: "openrouter", model: "meta/muse-spark-1.3-contributor", reasoning: "low" },
		{ provider: "openrouter", model: "z-ai/glm-5.3-flash", reasoning: "medium" },
	],
	frontier: { provider: "openai-codex", model: "gpt-6-astra", reasoning: "low" },
	timeoutMs: 90_000,
	reviewEveryToolCalls: 10,
};

function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected an object`);
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], path: string) {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${path}.${key}: unknown setting`);
		if (value[key] === null) throw new Error(`${path}.${key}: null is not a valid setting`);
	}
}

function slot(value: unknown, path: string): Slot {
	const fields = object(value, path);
	keys(fields, ["provider", "model", "reasoning"], path);
	for (const key of ["provider", "model"]) {
		if (typeof fields[key] !== "string" || !(fields[key] as string).trim()) throw new Error(`${path}.${key}: expected a nonempty string`);
	}
	const reasoning = fields.reasoning ?? "low";
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoning as string)) throw new Error(`${path}.reasoning: invalid level`);
	return { provider: fields.provider as string, model: fields.model as string, reasoning: reasoning as Reasoning };
}

export function parseConfig(value: unknown): Config {
	const fields = object(value, "config");
	keys(fields, ["actor", "reviewers", "frontier", "timeoutMs", "reviewEveryToolCalls"], "config");
	const reviewers = fields.reviewers ?? DEFAULT_CONFIG.reviewers;
	if (!Array.isArray(reviewers) || reviewers.length < 1 || reviewers.length > 4) throw new Error("config.reviewers: expected 1–4 slots");
	const config = {
		actor: slot(fields.actor ?? DEFAULT_CONFIG.actor, "config.actor"),
		reviewers: reviewers.map((value, index) => slot(value, `config.reviewers[${index}]`)),
		frontier: slot(fields.frontier ?? DEFAULT_CONFIG.frontier, "config.frontier"),
		timeoutMs: fields.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
		reviewEveryToolCalls: fields.reviewEveryToolCalls ?? DEFAULT_CONFIG.reviewEveryToolCalls,
	};
	for (const [key, max] of [["timeoutMs", 600_000], ["reviewEveryToolCalls", 1000]] as const) {
		const value = config[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`config.${key}: expected an integer from 1 to ${max}`);
	}
	const ids = config.reviewers.map((value) => `${value.provider}/${value.model}`);
	if (new Set(ids).size !== ids.length) throw new Error("config.reviewers: duplicate model slots");
	return config as Config;
}

export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
	try {
		return parseConfig(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
