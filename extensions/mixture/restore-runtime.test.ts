import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sessionCost } from "../clean-footer/index.ts";
import { CHECKPOINT, parseCheckpoint } from "./checkpoint.ts";
import { defaultConfig } from "./config.ts";
import { createMixtureExtension } from "./index.ts";
import { emitMessage, emptyUsage, modelDefinition, type Registry } from "./provider.ts";

const tool = (id: string, name: string, args: Record<string, unknown>): AssistantMessage["content"] => [{ type: "toolCall", id, name, arguments: args }];
const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];

test("real Pi compaction and disk reload preserve role histories and current files without replay", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-restore-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		writeFileSync(join(dir, "fixture.txt"), "before\n");
		const preset = defaultConfig().presets.default;
		preset.lead = "fixture/lead"; preset.writer.model = "fixture/writer"; preset.reviewers = [];
		writeFileSync(join(dir, "mixture.json"), JSON.stringify({ version: 2, presets: { default: preset } }));
		const find: Registry["find"] = (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		const requests: Array<{ id: string; context: Context }> = [];
		const steps = [
			{ actor: "writer", content: tool("edit", "edit", { path: "fixture.txt", oldText: "before", newText: "after" }) },
			{ actor: "writer", content: text("Edited fixture.txt. No unrelated files changed.") },
			{ actor: "lead", content: text("Changed fixture.txt.") },
			{ actor: "writer", content: tool("reread", "read", { path: "fixture.txt" }) },
			{ actor: "writer", content: text("Read the current file. The manual edit remains.") },
			{ actor: "lead", content: text("Read the current file. Your manual edit remains.") },
		];
		let helpers = 0;
		const provider: Provider = { id: "fixture", name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => [find("fixture", "lead")!, find("fixture", "writer")!], stream: () => { throw new Error("Use simple"); },
			streamSimple: (model, context) => {
				requests.push({ id: model.id, context: JSON.parse(JSON.stringify(context)) });
				let content: AssistantMessage["content"];
				if (!context.tools?.length) { helpers++; content = text("The writer changed fixture.txt from before to after. Preserve any later human edits. Re-read current files."); }
				else {
					const step = steps.shift();
					if (!step || step.actor !== model.id) throw new Error(`Unexpected ${model.id}, wanted ${step?.actor}`);
					content = step.content;
				}
				const stream = createAssistantMessageEventStream();
				emitMessage(stream, { role: "assistant", api: "fixture", provider: "fixture", model: model.id, content,
					stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
					usage: { ...emptyUsage(), input: 10, output: 1, totalTokens: 11, cost: { ...emptyUsage().cost, input: 0.001, total: 0.001 } } });
				return stream;
			} };
		const initialRegistry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
		const errors: unknown[] = [];
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 1024 }, retry: { enabled: false } });
		const open = async (manager: SessionManager) => {
			const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi: ExtensionAPI) => { pi.registerProvider(provider); }, (pi: ExtensionAPI) => createMixtureExtension(pi, initialRegistry)] });
			await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
			const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog"), allowModelNetwork: false });
			const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager,
				modelRuntime: runtime, model: modelDefinition("default", preset, find), thinkingLevel: "off" });
			await result.session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
			return result.session;
		};
		session = await open(SessionManager.create(dir, join(dir, "sessions")));
		await session.prompt("Change fixture.txt before to after. Preserve unrelated edits.");
		expect((session.messages.at(-1) as AssistantMessage).errorMessage).toBeUndefined();
		expect(readFileSync(join(dir, "fixture.txt"), "utf8")).toBe("after\n");
		const entries = session.sessionManager.getEntries();
		const checkpoint = entries.findLast(entry => entry.type === "custom" && entry.customType === CHECKPOINT)!;
		expect(checkpoint.type).toBe("custom");
		const prior = parseCheckpoint((checkpoint as any).data);
		expect(prior.state.writer.messages.some(message => message.role === "toolResult" && message.toolCallId === "edit")).toBe(true);
		await session.compact();
		expect(helpers).toBe(1);
		expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		const file = session.sessionManager.getSessionFile()!;
		await session.extensionRunner!.emit({ type: "session_shutdown", reason: "reload" }); session.dispose(); session = undefined;
		writeFileSync(join(dir, "fixture.txt"), "after + manual edit\n");
		session = await open(SessionManager.open(file));
		await session.prompt("Inspect the current fixture without changing anything.");
		expect(steps).toHaveLength(0);
		expect(errors).toEqual([]);
		expect(readFileSync(join(dir, "fixture.txt"), "utf8")).toBe("after + manual edit\n");
		const resumed = requests.find(request => JSON.stringify(request.context.messages).includes("session restored"))!;
		expect(JSON.stringify(resumed.context.messages)).toContain("Inspect the current fixture");
		expect(JSON.stringify(resumed.context.messages)).toContain("Writer report");
		const latest = session.sessionManager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === CHECKPOINT)!;
		const restored = parseCheckpoint((latest as any).data);
		expect(restored.state.writer.calls).toBe(4);
		expect(restored.state.writer.messages.filter(message => message.role === "toolResult" && message.toolCallId === "edit")).toHaveLength(1);
		expect(session.getSessionStats().tokens.total).toBe(requests.length * 11);
		expect(session.getSessionStats().cost).toBeCloseTo(requests.length * 0.001);
		expect(sessionCost(session.sessionManager.getEntries())).toBeCloseTo(requests.length * 0.001);
	} finally {
		if (session) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
