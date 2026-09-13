import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type Provider, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createMixtureExtension } from "./index.ts";
import { emitMessage, emptyUsage, type Registry } from "./provider.ts";

const originalAgent = process.env.PI_CODING_AGENT_DIR;
const dirs: string[] = [];
afterEach(() => {
	if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgent;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const harness = async (config?: string, fast?: boolean) => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-index-")); dirs.push(dir); process.env.PI_CODING_AGENT_DIR = dir;
	if (config) writeFileSync(join(dir, "mixture.json"), config);
	const commands = new Map<string, any>(); const handlers = new Map<string, any>(); const providers: Provider[] = []; const tools: string[] = [];
	const roleOptions: Array<SimpleStreamOptions & { serviceTier?: string }> = [];
	let calls = 0;
	const registry: Registry = {
		find: (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: emptyUsage().cost }),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (model, _context, options) => {
			calls++; roleOptions.push(options ?? {}); const stream = createAssistantMessageEventStream();
			emitMessage(stream, { role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [{ type: "text", text: "summary" }], usage: emptyUsage(), stopReason: "stop", timestamp: 1 });
			return stream;
		} }) as any,
	};
	const pi = {
		registerCommand: (name: string, value: any) => commands.set(name, value),
		registerTool: (tool: any) => tools.push(tool.name),
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerProvider: (provider: Provider) => providers.push(provider),
		unregisterProvider: (id: string) => { const index = providers.findIndex(provider => provider.id === id); if (index >= 0) providers.splice(index, 1); },
		getActiveTools: () => ["read", "write", "edit", "bash"],
		setActiveTools: () => {},
		events: { emit(name: string, value: { enabled?: boolean }) { if (name === "fast:query" && fast !== undefined) value.enabled = fast; } },
	};
	await createMixtureExtension(pi as any, registry);
	return { dir, commands, handlers, providers, tools, registry, roleOptions, get calls() { return calls; } };
};
test("factory registers a native model without starting inference or old tools", async () => {
	const h = await harness();
	expect(h.providers).toHaveLength(1);
	expect(h.providers[0].getModels()[0].id).toBe("default");
	expect(h.calls).toBe(0);
	expect(h.tools).not.toContain("mixture_run");
	expect(h.tools).not.toContain("mixture_process");
	await h.handlers.get("session_start")({}, { modelRegistry: h.registry, thinkingLevel: "high", model: { provider: "ordinary" }, ui: { notify() {} } });
	expect(h.calls).toBe(0);
});
test("invalid config retains commands but registers no provider and writes no replacement", async () => {
	const h = await harness('{"models":["old/model"]}');
	expect(h.providers).toHaveLength(0);
	const notices: string[] = [];
	await h.commands.get("mixture").handler("status", { ui: { notify: (text: string) => notices.push(text) } });
	expect(notices[0]).toContain("version 2");
	expect(notices[0]).toContain("mixture.json");
});
test("helper calls use the lead only and return an ordinary assistant result", async () => {
	const h = await harness();
	const provider = h.providers[0];
	const result = await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "Summarize", timestamp: 1 }] }, { reasoning: "high", sessionId: "helper" }).result();
	expect(result.content).toEqual([{ type: "text", text: "summary" }]);
	expect(h.calls).toBe(1);
	expect(h.roleOptions[0].serviceTier).toBeUndefined();
	expect(result.provider).toBe("openai-codex");
});
test("role requests inherit explicit session fast mode", async () => {
	for (const [fast, serviceTier] of [[true, "priority"], [false, "default"]] as const) {
		const h = await harness(undefined, fast);
		const provider = h.providers[0];
		await provider.streamSimple(provider.getModels()[0], { messages: [{ role: "user", content: "Summarize", timestamp: 1 }] }, { sessionId: "helper" }).result();
		expect(h.roleOptions[0].serviceTier).toBe(serviceTier);
	}
});
for (const outcome of ["save", "cancel", "conflict"] as const) test(`configure ${outcome} preserves the explicit save boundary`, async () => {
	const original = '{"models":["old/model"]}';
	const h = await harness(original);
	const path = join(h.dir, "mixture.json");
	const notices: string[] = [];
	await h.commands.get("mixture").handler("configure", {
		hasUI: true, isIdle: () => true,
		modelRegistry: { ...h.registry, getAvailable: () => [h.registry.find("fixture", "lead")] },
		ui: {
			select: async (label: string, options: string[]) => label === "Independent reviewers" ? "0" : options[0],
			editor: async (_label: string, value: string) => value,
			confirm: async () => { if (outcome === "conflict") writeFileSync(path, "human changed this"); return outcome !== "cancel"; },
			notify: (text: string) => notices.push(text),
		},
	});
	const contents = readFileSync(path, "utf8");
	if (outcome === "save") {
		expect(JSON.parse(contents)).toMatchObject({ version: 2, presets: { default: { lead: "fixture/lead", reviewers: [] } } });
		expect(h.providers).toHaveLength(1);
		expect(notices[0]).toContain("Saved");
	} else {
		expect(contents).toBe(outcome === "cancel" ? original : "human changed this");
		expect(h.providers).toHaveLength(0);
		if (outcome === "conflict") expect(notices[0]).toContain("changed");
	}
	expect(h.calls).toBe(0);
});
