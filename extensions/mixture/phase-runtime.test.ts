import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { materializeCheckpoint } from "./checkpoint.ts";
import { defaultConfig } from "./config.ts";
import { createMixtureExtension } from "./index.ts";
import { emitMessage, emptyUsage, modelDefinition, type Registry } from "./provider.ts";

const text = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
const tool = (name: string, args: Record<string, unknown>): AssistantMessage["content"] => [{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args }];
const phaseId = (context: Context) => {
	const note = context.messages.findLast(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Harness phase tracking]"));
	return JSON.stringify(note).match(/Phase ID: ([\w-]+)/)?.[1];
};

for (const resolution of ["takeover", "prerequisite"] as const) test(`real Pi stalls survive compaction and disk reload before ${resolution}`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-phase-runtime-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		writeFileSync(join(dir, "fixture.txt"), "unchanged\n");
		writeFileSync(join(dir, "unrelated.txt"), "human work\n");
		const preset = defaultConfig().presets.default;
		preset.lead = "fixture/lead"; preset.writer.model = "fixture/writer"; preset.reviewers = [];
		writeFileSync(join(dir, "mixture.json"), JSON.stringify({ version: 2, presets: { default: preset } }));
		const find: Registry["find"] = (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: emptyUsage().cost });
		const brief = { task: "Fix fixture.txt", nextAction: "Replace unchanged with fixed and verify the file", acceptedEvidence: ["fixture.txt has the failing value; do not repeat broad source searches"], constraints: ["Preserve unrelated.txt"], successCriteria: ["fixture.txt contains fixed", "Verification exits zero"] };
		const steps: Array<{ actor: string; run: (context: Context) => AssistantMessage["content"] }> = [];
		const lead = (run: (context: Context) => AssistantMessage["content"]) => steps.push({ actor: "lead", run });
		const writer = (run: (context: Context) => AssistantMessage["content"]) => steps.push({ actor: "writer", run });
		lead(() => tool("mixture_control", { action: "delegate", ...brief }));
		for (let attempt = 1; attempt <= 3; attempt++) {
			writer(() => tool("read", { path: "fixture.txt" }));
			writer(() => text("I reread the same file; no new finding or change."));
			lead(context => tool("mixture_control", { action: "assess", phaseId: phaseId(context), assessment: "stalled", evidence: `Attempt ${attempt} only reread the known unchanged value; no criterion or uncertainty advanced` }));
			lead(context => tool("mixture_control", { action: "delegate", ...brief, phaseId: phaseId(context) }));
		}
		lead(() => text("The writer is stalled. Equivalent delegation is blocked; work is incomplete."));
		const requests: Array<{ actor: string; context: Context }> = [];
		let helpers = 0;
		const provider: Provider = {
			id: "fixture", name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => [find("fixture", "lead")!, find("fixture", "writer")!], stream: () => { throw new Error("Use simple"); },
			streamSimple: (model, context) => {
				let content: AssistantMessage["content"];
				if (!context.tools?.length) { helpers++; content = text("The same fixture repair remains stalled after two corrective attempts. Preserve the phase record and human edits."); }
				else {
					requests.push({ actor: model.id, context: JSON.parse(JSON.stringify(context)) });
					const step = steps.shift();
					if (!step || step.actor !== model.id) throw new Error(`Unexpected ${model.id}; expected ${step?.actor}`);
					content = step.run(context);
				}
				const stream = createAssistantMessageEventStream();
				emitMessage(stream, { role: "assistant", api: "fixture", provider: "fixture", model: model.id, content, timestamp: Date.now(), usage: { ...emptyUsage(), input: 1, totalTokens: 1, cost: { ...emptyUsage().cost, total: 0.001 } }, stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop" });
				return stream;
			},
		};
		const registry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 1024 }, retry: { enabled: false } });
		const errors: unknown[] = [];
		const statuses: string[] = [];
		const open = async (manager: SessionManager) => {
			const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi: ExtensionAPI) => pi.registerProvider(provider), (pi: ExtensionAPI) => createMixtureExtension(pi, registry)] });
			await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
			const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog"), allowModelNetwork: false });
			const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager, modelRuntime: runtime, model: modelDefinition("default", preset, find), thinkingLevel: "off" });
			await result.session.bindExtensions({ mode: "rpc", onError: error => errors.push(error), uiContext: {
				notify() {}, setStatus(key: string, value?: string) { if (key === "mixture" && value) statuses.push(value); },
			} as any });
			return result.session;
		};
		session = await open(SessionManager.create(dir, join(dir, "sessions")));
		await session.prompt("Fix fixture.txt and verify it. Preserve unrelated.txt.");
		expect((session.messages.at(-1) as AssistantMessage).errorMessage).toBeUndefined();
		expect(steps).toHaveLength(0);
		expect((session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
		const failedCalls = session.messages.filter(message => message.role === "toolResult" && message.toolName === "mixture_control" && message.isError);
		expect(failedCalls).toHaveLength(1);
		expect(JSON.stringify(failedCalls)).toContain("two corrective attempts");
		const stalled = materializeCheckpoint(session.sessionManager.getBranch()).checkpoint!.state.phase!;
		expect(stalled).toMatchObject({ attempt: 3, correction: true, failedCorrections: 2, assessment: "stalled" });
		expect(stalled.history).toHaveLength(3);
		expect(readFileSync(join(dir, "fixture.txt"), "utf8")).toBe("unchanged\n");
		const writerRequests = requests.filter(request => request.actor === "writer");
		expect(writerRequests).toHaveLength(6);
		const firstBrief = JSON.stringify(writerRequests[0].context.messages);
		for (const expected of ["Next action:", brief.nextAction, "Accepted evidence / do not repeat", brief.acceptedEvidence[0], "Standing constraints:", "Preserve unrelated.txt", "Phase success criteria", "Current step completion checks:"]) expect(firstBrief).toContain(expected);
		const stalledCost = (requests.length * 0.001).toFixed(3);
		expect(statuses.at(-1)).toBe(`lead · blocked · $${stalledCost}`);
		await session.compact();
		expect(helpers).toBe(1);
		expect(statuses).toContain(`lead · compacting · $${stalledCost}`);
		expect(statuses.at(-1)).toBe(`lead · blocked · $${stalledCost}`);
		const file = session.sessionManager.getSessionFile()!;
		await session.extensionRunner!.emit({ type: "session_shutdown", reason: "reload" }); session.dispose(); session = undefined;
		expect(materializeCheckpoint(SessionManager.open(file).getBranch()).checkpoint!.state.phase).toEqual(stalled);

		lead(context => tool("mixture_control", { action: "delegate", ...brief, phaseId: phaseId(context) }));
		if (resolution === "takeover") lead(() => tool("mixture_control", { action: "takeover" }));
		else lead(context => tool("mixture_control", { action: "delegate", ...brief, phaseId: phaseId(context), changedPrerequisite: { change: "User provided the exact replacement and approved applying it", evidence: "Latest user request says replace unchanged with fixed now" } }));
		const actor = resolution === "takeover" ? lead : writer;
		actor(() => tool("write", { path: "fixture.txt", content: "fixed\n" }));
		actor(() => tool("bash", { command: "test \"$(< fixture.txt)\" = fixed && printf verified" }));
		if (resolution === "prerequisite") writer(() => text("Applied the exact replacement and the verification exited zero."));
		lead(context => tool("mixture_control", { action: "assess", phaseId: phaseId(context), assessment: "complete", evidence: "fixture.txt contains fixed; the verification command exited zero" }));
		lead(() => text("Fixed fixture.txt and verified it. Unrelated human work was preserved."));
		const priorRequests = requests.length;
		session = await open(SessionManager.open(file));
		expect(statuses.at(-1)).toBe(`lead · blocked · $${stalledCost}`);
		await session.prompt(resolution === "takeover" ? "Continue the same repair; take over if still stalled." : "Replace unchanged with fixed now; I approve this exact replacement.");
		expect(steps).toHaveLength(0);
		expect(errors).toEqual([]);
		expect((session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
		expect(readFileSync(join(dir, "fixture.txt"), "utf8")).toBe("fixed\n");
		expect(readFileSync(join(dir, "unrelated.txt"), "utf8")).toBe("human work\n");
		const resumed = requests.slice(priorRequests);
		expect(JSON.stringify(resumed[0].context.messages)).toContain(`Phase ID: ${stalled.id}`);
		expect(JSON.stringify(resumed[0].context.messages)).toContain("failed corrective attempts: 2/2");
		const results = session.messages.filter(message => message.role === "toolResult" && message.isError);
		expect(JSON.stringify(results)).toContain("two corrective attempts");
		const completed = materializeCheckpoint(session.sessionManager.getBranch()).checkpoint!.state.phase!;
		expect(completed).toMatchObject({ id: stalled.id, assessment: "complete", attempt: resolution === "takeover" ? 3 : 4 });
		expect(completed.history.slice(0, 3)).toEqual(stalled.history);
		expect(statuses.at(-1)).toBe(`lead · idle · $${(requests.length * 0.001).toFixed(3)}`);
		if (resolution === "takeover") {
			expect(resumed.every(request => request.actor === "lead")).toBe(true);
			expect(completed.failedCorrections).toBe(2);
		} else {
			expect(completed.failedCorrections).toBe(0);
			expect(completed.history[3].kind).toBe("prerequisite");
			expect(resumed.filter(request => request.actor === "writer")).toHaveLength(3);
		}
	} finally {
		if (session) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
