import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ImageContent, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT, materializeCheckpoint } from "./checkpoint.ts";
import { defaultConfig } from "./config.ts";
import { createMixtureExtension } from "./index.ts";
import { emitMessage, emptyUsage, modelDefinition, type Registry } from "./provider.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" };
const hasImage = (context: Context) => context.messages.some(message => typeof message.content !== "string" && message.content.some(block => block.type === "image" && block.data === image.data));
const tool = (name: string, args: Record<string, unknown>): AssistantMessage["content"] => [{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args }];

for (const { textOnlyReviewer } of [
	{ textOnlyReviewer: false },
	{ textOnlyReviewer: true },
]) test(`real Pi image evidence reaches roles (textOnly=${textOnlyReviewer})`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-image-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const preset = defaultConfig().presets.default;
		preset.lead = "fixture/lead"; preset.writer.model = "fixture/writer";
		preset.reviewers = ["reviewer-a", "reviewer-b"].map(id => ({ model: `fixture/${id}`, thinking: "low" }));
		writeFileSync(join(dir, "mixture.json"), JSON.stringify({ version: 3, presets: { default: preset } }));
		const find: Registry["find"] = (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true,
			input: textOnlyReviewer && id === "reviewer-b" ? ["text"] : ["text", "image"], contextWindow: 100_000, maxTokens: 20_000, cost: emptyUsage().cost });
		const requests: Array<{ id: string; context: Context }> = [];
		let leadCalls = 0;
		const provider: Provider = {
			id: "fixture", name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => ["lead", "writer", "reviewer-a", "reviewer-b"].map(id => find("fixture", id)!), stream: () => { throw new Error("Use simple"); },
			streamSimple: (model, context) => {
				requests.push({ id: model.id, context: JSON.parse(JSON.stringify(context)) });
				let content: AssistantMessage["content"];
				if (model.id.startsWith("reviewer")) {
					const revision = Number(JSON.stringify(context.messages.filter(message => message.role === "user").at(-1)).match(/Review requested at revision (\d+)/)?.[1]);
					content = tool("mixture_review", { revision, findings: [], notes: "Image evidence was retained and inspected." });
				} else if (model.id === "writer") content = tool("mixture_control", { action: "report", report: "Inspected the attached image without changing files." });
				else if (++leadCalls % 2 === 1) content = tool("mixture_control", { action: "delegate", task: "Inspect the attached image", nextAction: "Read the image and report its visible contents", successCriteria: ["Preserve image evidence"] });
				else content = [{ type: "text", text: "The image was inspected without changing files." }];
				const stream = createAssistantMessageEventStream();
				emitMessage(stream, { role: "assistant", provider: model.provider, model: model.id, api: model.api, content,
					usage: { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 }, timestamp: Date.now(), stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop" });
				return stream;
			},
		};
		const registry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi: ExtensionAPI) => pi.registerProvider(provider), (pi: ExtensionAPI) => createMixtureExtension(pi, registry)] });
		await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog"), allowModelNetwork: false });
		const composite = modelDefinition("default", preset, find);
		expect(composite.input).toEqual(textOnlyReviewer ? ["text"] : ["text", "image"]);
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(dir),
			modelRuntime: runtime, model: composite, thinkingLevel: "low" }));
		const errors: unknown[] = []; await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
		await session.prompt("Inspect this attached image without changing files.", { images: [image] });
		expect(errors).toEqual([]);
		for (const id of ["lead", "writer", "reviewer-a", "reviewer-b"]) {
			const roleRequests = requests.filter(request => request.id === id);
			expect(roleRequests.length).toBeGreaterThan(0);
			expect(roleRequests.every(request => hasImage(request.context))).toBe(!(textOnlyReviewer && id === "reviewer-b"));
		}
		const entries = session.sessionManager.getEntries();
		const checkpoint = entries.findLast(entry => entry.type === "custom" && entry.customType === CHECKPOINT)!;
		expect(checkpoint.type).toBe("custom");
		const state = materializeCheckpoint(session.sessionManager.getBranch()).checkpoint!.state;
		expect(state.attachments).toEqual([image]);
		expect(state.reviewers.every(reviewer => reviewer.revision === 0)).toBe(true);
		expect(state.reviewers[0].imageWarning).toBeUndefined();
		if (textOnlyReviewer) expect(state.reviewers[1].imageWarning).toContain("image evidence omitted");
		else expect(state.reviewers[1].imageWarning).toBeUndefined();
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", model: "lead", stopReason: "stop" });
		if (textOnlyReviewer) {
			await session.prompt("Give a text-only follow-up with no new image evidence.");
			const nextEntries = session.sessionManager.getEntries();
			const nextCheckpoint = nextEntries.findLast(entry => entry.type === "custom" && entry.customType === CHECKPOINT)!;
			expect(nextCheckpoint.type).toBe("custom");
			const nextMaterialized = materializeCheckpoint(session.sessionManager.getBranch());
			expect(nextMaterialized.warning).toBeUndefined();
			const nextState = nextMaterialized.checkpoint!.state;
			expect(nextState.reviewers.every(reviewer => !reviewer.imageWarning)).toBe(true);
			expect(JSON.stringify(session.messages.at(-1))).not.toContain("Incomplete review");
		}
	} finally {
		if (session) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
