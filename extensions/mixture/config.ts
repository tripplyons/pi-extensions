import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface RoleConfig {
	model: string;
	thinking: ModelThinkingLevel;
	fast?: boolean;
	guidance?: string;
}

export const DEFAULT_LIMITS = {
	requestTimeoutMs: 240_000,
	writerRequestTimeoutMs: 240_000,
	writerIdleTimeoutMs: 240_000,
	writerTurns: 32,
	progressEveryBatches: 3,
	leadEveryProgressIntervals: 3,
	reviewerBatchTurns: 2,
	catchUpMs: 120_000,
	leadMaxTokens: 16_384,
	writerMaxTokens: 8_192,
	reviewerMaxTokens: 8_192,
};
export const MIN_ADVISOR_INTERVAL_MS = 60_000;
export const DEFAULT_ADVISOR_LIMITS = {
	requestTimeoutMs: 240_000,
	executorMaxTokens: 16_384,
	advisorMaxTokens: 4_096,
	advisorIntervalMs: 300_000,
};
export type AdvisorGitContext = "off" | "summary" | "full";
export interface AdvisorContext {
	maxChars: number;
	git: AdvisorGitContext;
	redactSecrets: boolean;
}
export interface AdvisorGates {
	plan: boolean;
	failure: boolean;
	completion: boolean;
}
export const DEFAULT_ADVISOR_CONTEXT: AdvisorContext = {
	maxChars: 15_000,
	git: "summary",
	redactSecrets: true,
};
export const DEFAULT_ADVISOR_GATES: AdvisorGates = {
	plan: false,
	failure: true,
	completion: false,
};
export type Limits = typeof DEFAULT_LIMITS & { maxCostUsd?: number };
export type AdvisorLimits = typeof DEFAULT_ADVISOR_LIMITS;
export interface HandoffPreset {
	mode: "handoff";
	lead: string;
	writer: RoleConfig;
	reviewers: RoleConfig[];
	limits: Limits;
}
export interface AdvisorPreset {
	mode: "advisor";
	preflight: boolean;
	executor: RoleConfig;
	advisor: RoleConfig;
	context: AdvisorContext;
	gates: AdvisorGates;
	limits: AdvisorLimits;
}
export type Preset = HandoffPreset | AdvisorPreset;
export interface MixtureConfig {
	version: 3;
	presets: Record<string, Preset>;
}

export const agentDir = (override?: string) => override ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const configPath = (dir?: string) => join(agentDir(dir), "mixture.json");
export const defaultAdvisorPreset = (): AdvisorPreset => ({
	mode: "advisor",
	preflight: true,
	executor: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
	advisor: { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
	context: { ...DEFAULT_ADVISOR_CONTEXT },
	gates: { ...DEFAULT_ADVISOR_GATES },
	limits: { ...DEFAULT_ADVISOR_LIMITS },
});

export const defaultConfig = (): MixtureConfig & { presets: Record<string, HandoffPreset> } => ({
	version: 3,
	presets: {
		default: {
			mode: "handoff",
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
	keys(input, ["model", "thinking", "fast", "guidance"], label);
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(input.thinking))) {
		throw new Error(`${label}.thinking must name a Pi thinking level`);
	}
	if (input.fast !== undefined && typeof input.fast !== "boolean") throw new Error(`${label}.fast must be boolean`);
	if (input.guidance !== undefined && (typeof input.guidance !== "string" || input.guidance.length > 16_000)) {
		throw new Error(`${label}.guidance must be a string of at most 16000 characters`);
	}
	return { model: model(input.model, `${label}.model`), thinking: input.thinking as ModelThinkingLevel,
		...(input.fast === undefined ? {} : { fast: input.fast }),
		...(input.guidance === undefined ? {} : { guidance: input.guidance as string }) };
}
function advisorGates(value: unknown, label: string): AdvisorGates {
	const input = value === undefined ? {} : object(value, label);
	keys(input, Object.keys(DEFAULT_ADVISOR_GATES), label);
	for (const [key, setting] of Object.entries(input)) if (typeof setting !== "boolean") throw new Error(`${label}.${key} must be boolean`);
	return { ...DEFAULT_ADVISOR_GATES, ...input } as AdvisorGates;
}
function positiveIntegers(value: unknown, defaults: Record<string, number>, ceilings: Record<string, number>, label: string) {
	const input = value === undefined ? {} : object(value, label);
	keys(input, Object.keys(defaults), label);
	for (const [key, setting] of Object.entries(input)) {
		if (!Number.isInteger(setting) || Number(setting) <= 0 || Number(setting) > ceilings[key]) throw new Error(`${label}.${key} must be a positive integer at most ${ceilings[key]}`);
	}
	return { ...defaults, ...input } as Record<string, number>;
}

export function parseConfig(value: unknown): MixtureConfig {
	const input = object(value, "config");
	if (input.version !== 3) throw new Error("Expected version 3 configuration. Run /mixture configure to replace the old configuration; migration is not supported.");
	keys(input, ["version", "presets"], "config");
	const presets = object(input.presets, "presets");
	if (!Object.keys(presets).length || Object.keys(presets).length > 16) throw new Error("Configure 1–16 presets");
	const parsed: Record<string, Preset> = {};
	for (const [name, value] of Object.entries(presets)) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || ["constructor", "prototype", "__proto__"].includes(name)) throw new Error(`Invalid preset name: ${name}`);
		const preset = object(value, name);
		const mode = preset.mode ?? "handoff";
		if (mode === "advisor") {
			keys(preset, ["mode", "preflight", "executor", "advisor", "context", "gates", "limits"], name);
			if (preset.preflight !== undefined && typeof preset.preflight !== "boolean") throw new Error(`${name}.preflight must be boolean`);
			const context = preset.context === undefined ? {} : object(preset.context, `${name}.context`);
			keys(context, Object.keys(DEFAULT_ADVISOR_CONTEXT), `${name}.context`);
			if (context.maxChars !== undefined && (!Number.isInteger(context.maxChars) || Number(context.maxChars) < 1 || Number(context.maxChars) > 1_000_000)) throw new Error(`${name}.context.maxChars must be an integer from 1 to 1000000`);
			if (context.git !== undefined && !["off", "summary", "full"].includes(String(context.git))) throw new Error(`${name}.context.git must be off, summary, or full`);
			if (context.redactSecrets !== undefined && typeof context.redactSecrets !== "boolean") throw new Error(`${name}.context.redactSecrets must be boolean`);
			const configuredLimits = preset.limits === undefined ? {} : object(preset.limits, `${name}.limits`);
			keys(configuredLimits, [...Object.keys(DEFAULT_ADVISOR_LIMITS), "maxCalls"], `${name}.limits`);
			if (configuredLimits.maxCalls !== undefined && (!Number.isInteger(configuredLimits.maxCalls) || Number(configuredLimits.maxCalls) <= 0 || Number(configuredLimits.maxCalls) > 256)) throw new Error(`${name}.limits.maxCalls must be a positive integer at most 256`);
			const { maxCalls: _legacyMaxCalls, ...currentLimits } = configuredLimits;
			if (currentLimits.advisorIntervalMs !== undefined && Number(currentLimits.advisorIntervalMs) < MIN_ADVISOR_INTERVAL_MS) throw new Error(`${name}.limits.advisorIntervalMs must be at least ${MIN_ADVISOR_INTERVAL_MS}ms`);
			parsed[name] = {
				mode,
				preflight: preset.preflight === undefined ? true : preset.preflight,
				executor: role(preset.executor, `${name}.executor`),
				advisor: role(preset.advisor, `${name}.advisor`),
				context: { ...DEFAULT_ADVISOR_CONTEXT, ...context } as AdvisorPreset["context"],
				gates: advisorGates(preset.gates, `${name}.gates`),
				limits: positiveIntegers(currentLimits, DEFAULT_ADVISOR_LIMITS, { requestTimeoutMs: 600_000, executorMaxTokens: 131_072, advisorMaxTokens: 131_072, advisorIntervalMs: 86_400_000 }, `${name}.limits`) as unknown as AdvisorLimits,
			};
			continue;
		}
		if (mode !== "handoff") throw new Error(`${name}.mode must be handoff or advisor`);
		keys(preset, ["mode", "lead", "writer", "reviewers", "limits"], name);
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
			mode,
			lead: model(preset.lead, `${name}.lead`),
			writer: role(preset.writer, `${name}.writer`),
			reviewers: preset.reviewers.map((value, index) => role(value, `${name}.reviewers[${index}]`)),
			limits: { ...DEFAULT_LIMITS, ...configuredLimits },
		};
	}
	return { version: 3, presets: parsed };
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
