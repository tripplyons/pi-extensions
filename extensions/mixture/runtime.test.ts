import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./config.ts";
import { createMixtureExtension } from "./index.ts";
import { emitMessage, emptyUsage, modelDefinition, type Registry } from "./provider.ts";

const tool = (id: string, name: string, args: Record<string, unknown>): AssistantMessage["content"] => [{ type: "toolCall", id, name, arguments: args }];
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];

for (const denied of [false, true]) test(`real Pi tool lifecycle preserves the checkout and permission hooks (denied=${denied})`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-native-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		writeFileSync(join(dir, "fixture.txt"), "before\n");
		writeFileSync(join(dir, "unrelated.txt"), "uncommitted user edits\n");
		const preset = defaultConfig().presets.default;
		preset.lead = "fixture/lead"; preset.writer.model = "fixture/writer"; preset.reviewers = [];
		writeFileSync(join(dir, "mixture.json"), JSON.stringify({ version: 2, presets: { default: preset } }));
		const find: Registry["find"] = (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		const requests: Array<{ id: string; context: Context }> = [];
		const steps = [
			{ actor: "lead", content: tool("delegate", "mixture_control", { action: "delegate", task: "Change fixture.txt and verify it", constraints: ["Preserve unrelated.txt"], successCriteria: ["fixture.txt contains after", "The verification command passes"] }) },
			{ actor: "writer", content: tool("edit", "edit", { path: "fixture.txt", oldText: "before", newText: "after" }) },
			{ actor: "writer", content: tool("read", "read", { path: "fixture.txt" }) },
			{ actor: "writer", content: tool("verify", "bash", { command: `test "$(< fixture.txt)" = ${denied ? "before" : "after"} && printf verification-passed` }) },
			{ actor: "writer", content: text(denied ? "Edit was denied by the permission hook. File is unchanged." : "Edited fixture.txt and confirmed after using read.") },
			{ actor: "lead", content: text(denied ? "The edit was denied; no changes made." : "Changed fixture.txt and verified its contents.") },
		];
		const provider: Provider = {
			id: "fixture", name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => [find("fixture", "lead")!, find("fixture", "writer")!],
			stream: () => { throw new Error("Use simple"); },
			streamSimple: (model, context) => {
				requests.push({ id: model.id, context: JSON.parse(JSON.stringify(context)) });
				const step = steps.shift();
				if (!step || step.actor !== model.id) throw new Error(`Unexpected role ${model.id}; wanted ${step?.actor}`);
				const stream = createAssistantMessageEventStream();
				emitMessage(stream, { role: "assistant", api: "fixture", provider: "fixture", model: model.id, content: step.content,
					stopReason: step.content.some(block => block.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
					usage: { ...emptyUsage(), input: 10, output: 1, totalTokens: 11 } });
				return stream;
			},
		};
		const initialRegistry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
		const events: string[] = [];
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [
				(pi: ExtensionAPI) => { pi.registerProvider(provider); pi.on("tool_call", event => { events.push(`call:${event.toolName}`); if (denied && event.toolName === "edit") return { block: true, reason: "Fixture permission denial" }; }); pi.on("tool_result", event => { events.push(`result:${event.toolName}:${event.isError}`); }); },
				(pi: ExtensionAPI) => createMixtureExtension(pi, initialRegistry),
			],
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
			sessionManager: SessionManager.inMemory(dir), modelRuntime: runtime, model: modelDefinition("default", preset, find), thinkingLevel: "high" }));
		const errors: unknown[] = [];
		await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
		await session.prompt("Change fixture.txt before to after. Preserve unrelated.txt. Verify by reading.");
		expect(errors).toEqual([]);
		expect((session.messages.at(-1) as AssistantMessage).errorMessage).toBeUndefined();
		expect(steps).toHaveLength(0);
		expect(readFileSync(join(dir, "fixture.txt"), "utf8")).toBe(denied ? "before\n" : "after\n");
		expect(readFileSync(join(dir, "unrelated.txt"), "utf8")).toBe("uncommitted user edits\n");
		expect(events).toContain("call:edit");
		if (!denied) expect(events).toContain("result:edit:false");
		expect(session.messages.find(message => message.role === "toolResult" && message.toolCallId === "edit")).toMatchObject({ isError: denied });
		expect(JSON.stringify(requests[3].context.messages)).toContain(denied ? "Fixture permission denial" : "Successfully replaced");
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", model: "lead", stopReason: "stop" });
		expect(JSON.stringify(session.messages.at(-1))).toContain(denied ? "denied" : "verified");
		expect(session.getSessionStats().tokens.total).toBe(66);
		expect(JSON.stringify(session.messages)).toContain("verification-passed");
		expect(existsSync(join(dir, ".git"))).toBe(false);
		const callsBefore = requests.length;
		await session.setModel(find("fixture", "lead")!);
		expect(session.getActiveToolNames()).not.toContain("mixture_control");
		expect(requests).toHaveLength(callsBefore);
	} finally {
		if (session) { await session.extensionRunner?.emit({ type: "session_shutdown" }); session.dispose(); }
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);

test("context marker prevents stale nested usage from retriggering root compaction", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-context-accounting-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const preset = defaultConfig().presets.default;
		preset.lead = "fixture/lead"; preset.writer.model = "fixture/writer"; preset.reviewers = [];
		writeFileSync(join(dir, "mixture.json"), JSON.stringify({ version: 2, presets: { default: preset } }));
		const find: Registry["find"] = (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 250_000, maxTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		const steps = [
			{ actor: "lead", content: tool("delegate", "mixture_control", { action: "delegate", task: "Complete the work", successCriteria: ["The request is complete"] }) },
			{ actor: "writer", content: text("Inspected the request and completed the work.") },
			{ actor: "lead", content: text("Work completed.") },
		];
		let helpers = 0;
		const provider: Provider = {
			id: "fixture", name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => [find("fixture", "lead")!, find("fixture", "writer")!], stream: () => { throw new Error("Use simple"); },
			streamSimple: (model, context) => {
				let content: AssistantMessage["content"];
				let input: number;
				if (!context.tools?.length) { helpers++; content = text("Compact summary"); input = 10; }
				else {
					const step = steps.shift();
					if (!step || step.actor !== model.id) throw new Error(`Unexpected role ${model.id}; wanted ${step?.actor}`);
					content = step.content; input = model.id === "writer" ? 225_000 : 100;
				}
				const stream = createAssistantMessageEventStream();
				emitMessage(stream, { role: "assistant", api: "fixture", provider: "fixture", model: model.id, content,
					stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(), usage: { ...emptyUsage(), input, totalTokens: input } });
				return stream;
			},
		};
		const registry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: true, reserveTokens: 60_000, keepRecentTokens: 20_000 }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi: ExtensionAPI) => pi.registerProvider(provider), (pi: ExtensionAPI) => createMixtureExtension(pi, registry)] });
		await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog"), allowModelNetwork: false });
		const manager = SessionManager.inMemory(dir);
		manager.appendMessage({ role: "user", content: "Old request", timestamp: Date.now() - 20_000 });
		const stale = manager.appendMessage({ role: "assistant", api: "fixture", provider: "mixture", model: "default", content: text("Old response"), stopReason: "stop", timestamp: Date.now() - 10_000,
			usage: { ...emptyUsage(), input: 225_000, totalTokens: 225_000 } });
		manager.appendCompaction("Previous compacted context", stale, 225_000);
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
			sessionManager: manager, modelRuntime: runtime, model: modelDefinition("default", preset, find), thinkingLevel: "off" }));
		const tokensBefore = session.getSessionStats().tokens.total;
		const errors: unknown[] = []; await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
		await session.prompt("Complete a small task.");
		expect(errors).toEqual([]);
		expect(helpers).toBe(0);
		expect(steps).toHaveLength(0);
		expect(session.sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(session.getSessionStats().tokens.total - tokensBefore).toBe(225_200);
		expect(session.getContextUsage()?.tokens).toBeLessThan(10_000);
	} finally {
		if (session) { await session.extensionRunner?.emit({ type: "session_shutdown" }); session.dispose(); }
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
