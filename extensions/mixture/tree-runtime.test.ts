import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT, materializeCheckpoint } from "./checkpoint.ts";
import { defaultConfig } from "./config.ts";
import { createMixtureExtension } from "./index.ts";
import { emitMessage, emptyUsage, modelDefinition, type Registry } from "./provider.ts";

const tool = (name: string, args: Record<string, unknown>): AssistantMessage["content"] => [{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args }];
const has = (context: Context, text: string) => JSON.stringify(context.messages).includes(text);

test("real Pi tree navigation starts the selected branch without stale reviewer findings", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-tree-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const preset = defaultConfig().presets.default;
		preset.lead = "fixture/lead"; preset.writer.model = "fixture/writer";
		preset.reviewers = [{ model: "fixture/reviewer", thinking: "low" }];
		writeFileSync(join(dir, "mixture.json"), JSON.stringify({ version: 2, presets: { default: preset } }));
		const find: Registry["find"] = (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: emptyUsage().cost });
		const requests: Array<{ id: string; context: Context }> = [];
		const provider: Provider = {
			id: "fixture", name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => ["lead", "writer", "reviewer"].map(id => find("fixture", id)!), stream: () => { throw new Error("Use simple"); },
			streamSimple: (model, context) => {
				requests.push({ id: model.id, context: JSON.parse(JSON.stringify(context)) });
				let content: AssistantMessage["content"];
				if (model.id === "reviewer") {
					const revision = Number(JSON.stringify(context.messages.filter(message => message.role === "user").at(-1)).match(/Review requested at revision (\d+)/)?.[1]);
					const findings = has(context, "First branch task") ? [{ id: "old-branch-nit", severity: "nit", summary: "Only applies to the abandoned branch" }] : [];
					content = tool("mixture_review", { revision, findings });
				} else if (model.id === "writer") content = tool("mixture_control", { action: "report", report: "First branch work completed." });
				else if (has(context, "First branch task") && !has(context, "Writer report")) content = tool("mixture_control", { action: "delegate", task: "Complete first branch work", successCriteria: ["Report completion"] });
				else content = [{ type: "text", text: has(context, "Second branch task") ? "Second branch completed cleanly." : "First branch completed." }];
				const stream = createAssistantMessageEventStream();
				emitMessage(stream, { role: "assistant", provider: model.provider, model: model.id, api: model.api, content, usage: { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 },
					timestamp: Date.now(), stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop" });
				return stream;
			},
		};
		const registry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi: ExtensionAPI) => pi.registerProvider(provider), (pi: ExtensionAPI) => createMixtureExtension(pi, registry)] });
		await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
			sessionManager: SessionManager.inMemory(dir), modelRuntime: runtime, model: modelDefinition("default", preset, find), thinkingLevel: "low" }));
		const errors: unknown[] = []; await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
		await session.prompt("First branch task");
		const firstEntries = session.sessionManager.getEntries();
		const firstCheckpoint = firstEntries.findLast(entry => entry.type === "custom" && entry.customType === CHECKPOINT)!;
		expect(firstCheckpoint.type).toBe("custom");
		expect(materializeCheckpoint(session.sessionManager.getBranch()).checkpoint!.state.reviewers[0].findings[0].id).toBe("old-branch-nit");
		const firstUser = session.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user")!;
		const navigation = await session.navigateTree(firstUser.id);
		expect(navigation).toMatchObject({ cancelled: false, editorText: "First branch task" });
		await session.prompt("Second branch task");
		expect(errors).toEqual([]);
		const secondLead = requests.filter(request => request.id === "lead").at(-1)!;
		expect(has(secondLead.context, "Second branch task")).toBe(true);
		expect(has(secondLead.context, "old-branch-nit")).toBe(false);
		expect(JSON.stringify(session.messages.at(-1))).not.toContain("old-branch-nit");
		const secondEntries = session.sessionManager.getEntries();
		const checkpoint = secondEntries.findLast(entry => entry.type === "custom" && entry.customType === CHECKPOINT)!;
		expect(checkpoint.type).toBe("custom");
		const state = materializeCheckpoint(session.sessionManager.getBranch()).checkpoint!.state;
		expect(state.reviewers[0].findings).toEqual([]);
		expect(state.task).toBe("Second branch task");
	} finally {
		if (session) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
