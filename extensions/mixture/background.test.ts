import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./config.ts";
import { createMixtureExtension } from "./index.ts";
import { emitMessage, emptyUsage, modelDefinition, type Registry } from "./provider.ts";

const tool = (id: string, name: string, args: Record<string, unknown>): AssistantMessage["content"] => [{ type: "toolCall", id, name, arguments: args }];

test("native background writer retains its lease until explicit stop, then lead takes over", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-background-"));
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, PI_BG_BASH_TMUX_SOCKET: process.env.PI_BG_BASH_TMUX_SOCKET };
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.XDG_CACHE_HOME = join(dir, "cache");
	process.env.PI_BG_BASH_TMUX_SOCKET = join(dir, "bg.sock");
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const { default: bgBash } = await import("../bg-bash/index.ts");
		const preset = defaultConfig().presets.default;
		preset.lead = "fixture/lead"; preset.writer.model = "fixture/writer"; preset.reviewers = [];
		writeFileSync(join(dir, "mixture.json"), JSON.stringify({ version: 2, presets: { default: preset } }));
		const find: Registry["find"] = (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		const roles: string[] = [];
		const steps: Array<{ actor: string; content: (context: Context) => AssistantMessage["content"] }> = [
			{ actor: "lead", content: () => tool("delegate", "mixture_control", { action: "delegate", task: "Run and stop the bounded fixture job", successCriteria: ["The job is stopped before handoff"] }) },
			{ actor: "writer", content: () => tool("start", "bash", { command: "printf started; read -r release; printf unexpected > output.txt", timeout: 0.1 }) },
			{ actor: "writer", content: () => tool("blocked-report", "mixture_control", { action: "report", report: "Handing back early" }) },
			{ actor: "writer", content: context => {
				const start = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "start");
				if (start?.role !== "toolResult" || !start.details?.job?.id) throw new Error("No native job ID");
				expect(JSON.stringify(context.messages)).toContain("Writer handoff is blocked by running jobs");
				return tool("stop", "bg_process", { action: "kill", id: start.details.job.id });
			} },
			{ actor: "writer", content: () => tool("report", "mixture_control", { action: "report", report: "Stopped the job; no output file was written." }) },
			{ actor: "lead", content: () => tool("take", "mixture_control", { action: "takeover" }) },
			{ actor: "lead", content: () => tool("write", "write", { path: "output.txt", content: "lead owns the lease\n" }) },
			{ actor: "lead", content: () => [{ type: "text", text: "Job stopped. Lead wrote the result." }] },
		];
		const provider: Provider = {
			id: "fixture", name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => [find("fixture", "lead")!, find("fixture", "writer")!],
			stream: () => { throw new Error("Use simple"); },
			streamSimple: (model, context) => {
				roles.push(model.id);
				const step = steps.shift();
				if (!step || step.actor !== model.id) throw new Error(`Unexpected ${model.id} request; wanted ${step?.actor}`);
				const content = step.content(context);
				const stream = createAssistantMessageEventStream();
				emitMessage(stream, { role: "assistant", api: "fixture", provider: "fixture", model: model.id, content,
					stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(), usage: emptyUsage() });
				return stream;
			},
		};
		const initialRegistry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi: ExtensionAPI) => pi.registerProvider(provider), bgBash, (pi: ExtensionAPI) => createMixtureExtension(pi, initialRegistry)],
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
			sessionManager: SessionManager.inMemory(dir), modelRuntime: runtime, model: modelDefinition("default", preset, find), thinkingLevel: "high" }));
		const errors: unknown[] = [];
		await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
		await session.prompt("Run the bounded fixture job, stop it explicitly, and let the lead write output.txt.");
		expect(errors).toEqual([]);
		expect((session.messages.at(-1) as AssistantMessage).errorMessage).toBeUndefined();
		expect(steps).toHaveLength(0);
		expect(roles).toEqual(["lead", "writer", "writer", "writer", "writer", "lead", "lead", "lead"]);
		expect(readFileSync(join(dir, "output.txt"), "utf8")).toBe("lead owns the lease\n");
		expect(session.messages.find(message => message.role === "toolResult" && message.toolCallId === "blocked-report")).toMatchObject({ isError: true });
	} finally {
		if (session) { await session.extensionRunner?.emit({ type: "session_shutdown" }); session.dispose(); }
		spawnSync("tmux", ["-S", "bg.sock", "kill-server"], { cwd: dir });
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
