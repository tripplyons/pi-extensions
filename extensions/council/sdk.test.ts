import { expect, test } from "bun:test";
import { Type } from "typebox";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import council from "./index.ts";

test.each([
	{ id: "council", count: 3, effort: ["medium", "medium", "low"] },
	{ id: "council-openai", count: 2, effort: ["high", "high"] },
])("real SDK routes $id and refreshes after eight tool turns", async ({ id: modelId, count, effort: expectedEffort }) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-council-sdk-"));
	const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, "auth.json"), refreshOnCreate: false });
	let advisors = 0;
	let execution = 0;
	let steps = 0;
	const tiers: unknown[] = [];
	const effort: unknown[] = [];
	let previousPrompt: { length: number; text: string } | undefined;
	for (const id of modelId === "council-openai" ? ["openai"] : ["openai", "anthropic"]) {
		const models = runtime.getModels(id).filter(model => ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5"].includes(model.id));
		const provider: Provider = {
			id, name: id,
			auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key", source: "fixture" }),
				resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => models,
			stream: () => { throw new Error("Use streamSimple"); },
			streamSimple(model, context, options) {
				const stream = createAssistantMessageEventStream();
				(async () => {
					const isAdvisor = context.messages[0]?.role === "system" &&
						String(context.messages[0].content).includes("independent advisor");
					const payload = await options?.onPayload?.({ model: model.id }, model);
					if (isAdvisor) {
						advisors++;
						effort.push(options?.reasoning);
					} else {
						execution++;
						expect(advisors).toBe(execution <= 8 ? count : count * 2);
						expect(options?.reasoning).toBe("medium");
						const round = execution <= 8 ? 1 : 2;
						const guidance = context.messages.filter(message => message.role === "system" &&
							String(message.content).includes(`Synthesize all ${count} advisory answers`));
						expect(guidance).toHaveLength(round);
						if (execution === 1 || execution === 9) expect(context.messages.at(-1)).toBe(guidance.at(-1));
						if (previousPrompt) {
							expect(JSON.stringify(context.messages.slice(0, previousPrompt.length))).toBe(previousPrompt.text);
						}
						previousPrompt = { length: context.messages.length, text: JSON.stringify(context.messages) };
						tiers.push(payload);
					}
					const content: AssistantMessage["content"] = isAdvisor
						? [{ type: "text", text: `Advice from ${model.id}` }]
						: execution <= 9
							? [{ type: "toolCall", id: `step-${execution}`, name: "council_test_step", arguments: {} }]
							: [{ type: "text", text: "Done." }];
					const message: AssistantMessage = { role: "assistant", provider: id, model: model.id, api: model.api,
						content, stopReason: isAdvisor || execution > 9 ? "stop" : "toolUse", timestamp: Date.now(),
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
					stream.end();
				})().catch(error => { stream.end(); throw error; });
				return stream;
			},
		};
		runtime.registerNativeProvider(provider);
		await runtime.setRuntimeApiKey(id, "fixture");
	}
	const loader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true,
		noThemes: true, extensionFactories: [council, pi => {
			pi.on("session_start", () => pi.setActiveTools(["council_test_step"]));
		}],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: dir, agentDir: dir, modelRuntime: runtime, resourceLoader: loader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		customTools: [{
			name: "council_test_step", label: "Test step", description: "Perform one in-memory test step.",
			parameters: Type.Object({}),
			async execute() { steps++; return { content: [{ type: "text", text: "Step done." }], details: undefined }; },
		}],
		noTools: true,
	});
	try {
		const errors: string[] = [];
		await session.bindExtensions({ onError: event => errors.push(event.error) });
		const virtual = runtime.getModel("tripp", modelId)!;
		expect(virtual).toBeDefined();
		await session.setModel(virtual);
		await session.prompt("Perform nine test steps, then stop.");
		expect(errors).toEqual([]);
		expect(session.messages.filter(message => message.role === "assistant").map(message => message.errorMessage).filter(Boolean)).toEqual([]);
		expect(steps).toBe(9);
		expect(execution).toBe(10);
		expect(advisors).toBe(count * 2);
		expect(effort).toEqual([...expectedEffort, ...expectedEffort]);
		expect(tiers.every(payload => (payload as any)?.service_tier === "priority")).toBe(true);
		const saved = session.sessionManager.getBranch().filter(entry => entry.type === "custom" &&
			entry.customType === "pi.virtual-model-state");
		expect(saved).toHaveLength(10);
		const last = saved.at(-1) as any;
		expect(last.data.state.round).toBe(2);
		expect(last.data.state.turns).toBe(2);
	} finally { session.dispose(); await rm(dir, { recursive: true, force: true }); }
});
