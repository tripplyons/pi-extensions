import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface RoleConfig {
	model: string;
	thinking: ModelThinkingLevel;
	guidance?: string;
}

export const DEFAULT_LIMITS = {
	requestTimeoutMs: 240_000,
	writerTurns: 32,
	reviewEveryBatches: 3,
	leadEveryReviews: 3,
	reviewerBatchTurns: 2,
	catchUpMs: 120_000,
	leadMaxTokens: 16_384,
	writerMaxTokens: 8_192,
	reviewerMaxTokens: 8_192,
};
export type Limits = typeof DEFAULT_LIMITS & { maxCostUsd?: number };
export interface Preset {
	lead: string;
	writer: RoleConfig;
	reviewers: RoleConfig[];
	limits: Limits;
}
export interface MixtureConfig {
	version: 2;
	presets: Record<string, Preset>;
}

export const agentDir = (override?: string) => override ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const configPath = (dir?: string) => join(agentDir(dir), "mixture.json");
export const defaultConfig = (): MixtureConfig => ({
	version: 2,
	presets: {
		default: {
			lead: "openai-codex/gpt-6-astra",
			writer: { model: "openrouter/z-ai/glm-5.3-flash", thinking: "low" },
			reviewers: [
				{ model: "openrouter/z-ai/glm-5.3-flash", thinking: "low" },
			],
			limits: { ...DEFAULT_LIMITS },
		},
	},
});

export function splitModel(value: string): [string, string] {
	const slash = value.indexOf("/");
	if (slash < 1 || slash === value.length - 1 || /\s/.test(value)) throw new Error(`Invalid provider/model: ${value}`);
	const provider = value.slice(0, slash);
	if (provider === "mixture") throw new Error("Mixture roles cannot reference mixture models");
	return [provider, value.slice(slash + 1)];
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
function model(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a provider/model string`);
	splitModel(value);
	return value;
}
function role(value: unknown, label: string): RoleConfig {
	const input = object(value, label);
	keys(input, ["model", "thinking", "guidance"], label);
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(input.thinking))) {
		throw new Error(`${label}.thinking must name a Pi thinking level`);
	}
	if (input.guidance !== undefined && (typeof input.guidance !== "string" || input.guidance.length > 16_000)) {
		throw new Error(`${label}.guidance must be a string of at most 16000 characters`);
	}
	return { model: model(input.model, `${label}.model`), thinking: input.thinking as ModelThinkingLevel,
		...(input.guidance === undefined ? {} : { guidance: input.guidance as string }) };
}

export function parseConfig(value: unknown): MixtureConfig {
	const input = object(value, "config");
	if (input.version !== 2) throw new Error("Expected version 2 configuration. Run /mixture configure to replace the old configuration; migration is not supported.");
	keys(input, ["version", "presets"], "config");
	const presets = object(input.presets, "presets");
	if (!Object.keys(presets).length || Object.keys(presets).length > 16) throw new Error("Configure 1–16 presets");
	const parsed: Record<string, Preset> = {};
	for (const [name, value] of Object.entries(presets)) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || ["constructor", "prototype", "__proto__"].includes(name)) throw new Error(`Invalid preset name: ${name}`);
		const preset = object(value, name);
		keys(preset, ["lead", "writer", "reviewers", "limits"], name);
		if (!Array.isArray(preset.reviewers) || preset.reviewers.length > 4) throw new Error(`${name}.reviewers must contain 0–4 roles`);
		const configuredLimits = preset.limits === undefined ? {} : object(preset.limits, `${name}.limits`);
		keys(configuredLimits, [...Object.keys(DEFAULT_LIMITS), "maxCostUsd"], "limits");
		for (const [key, limit] of Object.entries(configuredLimits)) {
			const ceiling = key.endsWith("Ms") ? 600_000 : key.endsWith("Tokens") ? 131_072 : key === "maxCostUsd" ? 1000 : 256;
			if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || limit > ceiling || (key !== "maxCostUsd" && !Number.isInteger(limit))) {
				throw new Error(`${name}.limits.${key} must be positive and at most ${ceiling}${key === "maxCostUsd" ? "" : " (integer)"}`);
			}
		}
		parsed[name] = {
			lead: model(preset.lead, `${name}.lead`),
			writer: role(preset.writer, `${name}.writer`),
			reviewers: preset.reviewers.map((value, index) => role(value, `${name}.reviewers[${index}]`)),
			limits: { ...DEFAULT_LIMITS, ...configuredLimits },
		};
	}
	return { version: 2, presets: parsed };
}

export function loadConfig(dir?: string): MixtureConfig {
	const path = configPath(dir);
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
		throw new Error(`Cannot read Mixture config at ${path}: ${String(error)}`);
	}
	try { return parseConfig(JSON.parse(text)); }
	catch (error) { throw new Error(`Invalid Mixture config at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function saveConfig(config: MixtureConfig, dir?: string, expected?: string | null) {
	const validated = parseConfig(config);
	const path = configPath(dir);
	if (expected !== undefined) {
		let current: string | null = null;
		try { current = readFileSync(path, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (current !== expected) throw new Error(`Mixture config changed while editing: ${path}. Reopen /mixture configure.`);
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally { rmSync(temporary, { force: true }); }
}
