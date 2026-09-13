import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./config.ts";
import { createMixtureExtension } from "./index.ts";
import { emitMessage, emptyUsage, modelDefinition, type Registry } from "./provider.ts";

const tool = (name: string, args: Record<string, unknown>): AssistantMessage["content"] => [{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args }];

test("leaving Mixture reports a surviving tracked shell job without killing it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-disclosure-"));
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, PI_BG_BASH_TMUX_SOCKET: process.env.PI_BG_BASH_TMUX_SOCKET };
	process.env.PI_CODING_AGENT_DIR = dir; process.env.XDG_CACHE_HOME = join(dir, "cache"); process.env.PI_BG_BASH_TMUX_SOCKET = join(dir, "bg.sock");
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const { default: bgBash } = await import("../bg-bash/index.ts");
		const preset = defaultConfig().presets.default; preset.lead = "fixture/lead"; preset.writer.model = "fixture/writer"; preset.reviewers = [];
		writeFileSync(join(dir, "mixture.json"), JSON.stringify({ version: 2, presets: { default: preset } }));
		const find: Registry["find"] = (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: emptyUsage().cost });
		const provider: Provider = { id: "fixture", name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => ["lead", "writer", "ordinary"].map(id => find("fixture", id)!), stream: () => { throw new Error("Use simple"); },
			streamSimple: (model) => {
				const content = model.id === "ordinary" ? [{ type: "text" as const, text: "Ordinary model resumed after the switch." }]
					: tool("bash", { command: "read -r release; printf unexpected > output.txt", timeout: 0.1 });
				const stream = createAssistantMessageEventStream(); emitMessage(stream, { role: "assistant", provider: model.provider, model: model.id, api: model.api, content,
					usage: emptyUsage(), timestamp: Date.now(), stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop" }); return stream;
			},
		};
		const registry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
		const notices: string[] = [];
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi: ExtensionAPI) => pi.registerProvider(provider), bgBash, (pi: ExtensionAPI) => createMixtureExtension(pi, registry), (pi: ExtensionAPI) => {
				pi.on("tool_result", async event => { if (event.toolName === "bash" && !event.isError) await session!.setModel(find("fixture", "ordinary")!); });
			}] });
		await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(dir),
			modelRuntime: runtime, model: modelDefinition("default", preset, find), thinkingLevel: "low" }));
		await session.bindExtensions({ mode: "rpc", onError: () => {}, uiContext: { notify: (message: string) => notices.push(message), setStatus() {} } as any });
		await session.prompt("Start the job, then switch models without stopping it.");
		expect(session.model).toMatchObject({ provider: "fixture", id: "ordinary" });
		expect(session.getActiveToolNames()).not.toContain("mixture_control");
		expect(notices.join("\n")).toContain("Mixture stopped inference, not shell jobs");
		expect(notices.join("\n")).toMatch(/Still running: .+/);
		expect(existsSync(join(dir, "output.txt"))).toBe(false);
	} finally {
		if (session) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		spawnSync("tmux", ["-S", "bg.sock", "kill-server"], { cwd: dir });
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
