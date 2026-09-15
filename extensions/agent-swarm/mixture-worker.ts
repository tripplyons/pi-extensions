import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, loadConfig, splitModel, type MixtureConfig, type Preset } from "../mixture/config.ts";
import { readJson, writeJson } from "./state.ts";

export interface MixtureWorkerSetup {
	presetName: string;
	preset: Preset;
	config: MixtureConfig;
	providers: string[];
	credentials: Record<string, unknown>;
	models?: { providers: Record<string, Record<string, unknown>> };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function stripJsonComments(value: string): string {
	let output = "";
	let quoted = false;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index]!;
		const next = value[index + 1];
		if (lineComment) {
			if (character === "\n" || character === "\r") {
				lineComment = false;
				output += character;
			} else output += " ";
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				output += "  ";
				index++;
			} else output += character === "\n" || character === "\r" ? character : " ";
			continue;
		}
		if (quoted) {
			output += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') {
			quoted = true;
			output += character;
		} else if (character === "/" && next === "/") {
			lineComment = true;
			output += "  ";
			index++;
		} else if (character === "/" && next === "*") {
			blockComment = true;
			output += "  ";
			index++;
		} else output += character;
	}
	return output;
}

function selectedModels(sourceAgent: string, providers: Set<string>) {
	const path = join(sourceAgent, "models.json");
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try { parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""))); }
	catch (error) { throw new Error(`Cannot read Pi model configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
	if (!isRecord(parsed) || !isRecord(parsed.providers)) throw new Error(`Invalid Pi model configuration at ${path}: providers must be an object`);
	const selected: Record<string, Record<string, unknown>> = {};
	for (const [provider, value] of Object.entries(parsed.providers)) {
		if (!providers.has(provider)) continue;
		if (!isRecord(value)) throw new Error(`Invalid Pi model configuration at ${path}: provider ${provider} must be an object`);
		const { apiKey: _apiKey, ...withoutCredential } = value;
		if (Object.keys(withoutCredential).length) selected[provider] = withoutCredential;
	}
	return Object.keys(selected).length ? { providers: selected } : undefined;
}

function presetName(model: string) {
	const slash = model.indexOf("/");
	if (slash < 1 || model.slice(0, slash) !== "mixture") return undefined;
	const name = model.slice(slash + 1);
	if (!name || name.includes("/")) throw new Error(`Invalid Mixture worker model: ${model}; expected mixture/<preset>`);
	return name;
}

export function resolveMixtureWorker(model: string, sourceAgent: string): MixtureWorkerSetup | undefined {
	const name = presetName(model);
	if (!name) return undefined;
	const sourceConfig = loadConfig(sourceAgent);
	const preset = sourceConfig.presets[name];
	if (!preset) throw new Error(`Unknown Mixture preset ${name} in ${configPath(sourceAgent)}`);
	const providers = [...new Set([preset.lead, preset.writer.model, ...preset.reviewers.map(role => role.model)].map(id => splitModel(id)[0]))];
	const authPath = join(sourceAgent, "auth.json");
	let stored: unknown;
	try { stored = readJson(authPath); }
	catch (error) { throw new Error(`Cannot read stored credentials at ${authPath}: ${error instanceof Error ? error.message : String(error)}`); }
	if (!isRecord(stored)) throw new Error(`Missing stored credentials for Mixture preset ${name}: ${providers.join(", ")}`);
	const missing = providers.filter(provider => !Object.hasOwn(stored, provider) || stored[provider] === null || stored[provider] === undefined);
	if (missing.length) throw new Error(`Missing stored credentials for Mixture preset ${name}: ${missing.join(", ")}`);
	const credentials = Object.fromEntries(providers.map(provider => [provider, stored[provider]]));
	const config = { version: 2 as const, presets: { [name]: preset } };
	return { presetName: name, preset, config, providers, credentials, models: selectedModels(sourceAgent, new Set(providers)) };
}

export function provisionMixtureWorker(model: string, sourceAgent: string, workerAgent: string): MixtureWorkerSetup | undefined {
	const setup = resolveMixtureWorker(model, sourceAgent);
	if (!setup) return undefined;
	writeJson(join(workerAgent, "auth.json"), setup.credentials);
	writeJson(join(workerAgent, "mixture.json"), setup.config);
	if (setup.models) writeJson(join(workerAgent, "models.json"), setup.models);
	return setup;
}
