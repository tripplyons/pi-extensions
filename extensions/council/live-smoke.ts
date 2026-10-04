// Opt-in subscription/API requests. Never included in npm test.
import assert from "node:assert/strict";
import { Type } from "typebox";
import { lazyStream, type AssistantMessageEvent, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import council from "./index.ts";
import subscription from "../openai-subscription/index.ts";

const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const records: { role: string; model: string; effort: unknown; tier?: unknown; stop?: string; tokens?: number }[] = [];
let steps = 0;
const loader = new DefaultResourceLoader({
	cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
	extensionFactories: [council, subscription, pi => {
		pi.on("session_start", (_event, ctx) => {
			pi.setActiveTools(["council_smoke_step"]);
			for (const id of ["openai", "openai-codex", "anthropic"]) {
				const provider = ctx.modelRegistry.getProvider(id);
				if (!provider) continue;
				const audited: Provider = {
					...provider,
					streamSimple(model, context, options) {
						const advisor = context.messages[0]?.role === "system" &&
							String(context.messages[0].content).includes("independent advisor");
						const record: typeof records[number] = {
							role: advisor ? "advisor" : "executor", model: model.id, effort: options?.reasoning,
						};
						records.push(record);
						console.log(JSON.stringify({ event: "request", ...record }));
						return lazyStream(model, async () => {
							const stream = provider.streamSimple(model, context, {
								...options,
								onPayload: async (payload, physical) => {
									const changed = await options?.onPayload?.(payload, physical);
									record.tier = ((changed ?? payload) as any).service_tier;
									return changed;
								},
							});
							return (async function* (): AsyncIterable<AssistantMessageEvent> {
								for await (const event of stream) {
									if (event.type === "done" || event.type === "error") {
										const message = event.type === "done" ? event.message : event.error;
										record.stop = message.stopReason;
										record.tokens = message.usage.totalTokens;
										console.log(JSON.stringify({ event: "result", ...record }));
									}
									yield event;
								}
							})();
						});
					},
				};
				pi.registerProvider(audited);
			}
		});
	}],
});
await loader.reload();
const { session } = await createAgentSession({
	cwd: process.cwd(), modelRuntime: runtime, resourceLoader: loader,
	sessionManager: SessionManager.inMemory(process.cwd()), noTools: true,
	settingsManager: SettingsManager.inMemory({
		retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: false,
	}),
	customTools: [{
		name: "council_smoke_step", label: "Smoke step",
		description: "Increment a harmless in-memory counter by one. No file or network access. Call this once per assistant response until the count reaches 9, then finish.",
		parameters: Type.Object({}),
		async execute() {
			assert(steps < 9, "The smoke task must stop after nine steps");
			steps++;
			console.log(JSON.stringify({ event: "step", count: steps }));
			return { content: [{ type: "text", text: `Counter is ${steps}. ${steps < 9 ? "Call once again in your next response." : "Finish now. Do not call more tools."}` }], details: undefined };
		},
	}],
});
try {
	const errors: string[] = [];
	await session.bindExtensions({ onError: event => errors.push(event.error) });
	await session.setModel(runtime.getModel("tripp", "council")!);
	const timer = setTimeout(() => session.abort(), 240_000);
	try {
		await session.prompt("This is an authorized live Council smoke test. The entire task is to call council_smoke_step exactly once per assistant response, for nine separate responses. Do not combine calls in one response. After the tool reports 9, reply briefly that the test is complete. Do not inspect or change files. No other work is needed.");
	} finally { clearTimeout(timer); }
	assert.deepEqual(errors, []);
	const failures = session.messages.filter(message => message.role === "assistant" &&
		(message.stopReason === "error" || message.stopReason === "aborted"));
	assert.equal(failures.length, 0, "A live model request failed or was aborted");
	assert.equal(steps, 9);
	const advisors = records.filter(record => record.role === "advisor");
	const executors = records.filter(record => record.role === "executor");
	assert.equal(advisors.length, 6, "Expected two consultations of three models");
	assert.equal(executors.length, 10, "Expected nine tool responses and one final answer");
	for (const record of records) {
		assert.equal(record.effort, record.model === "claude-opus-5-5" ? "low" : "medium");
		if (record.model !== "claude-opus-5-5") assert.equal(record.tier, "priority");
	}
	assert(records.every(record => record.stop === "stop" || record.stop === "toolUse"));
	console.log(JSON.stringify({ event: "verified", steps, consultations: advisors.length / 3,
		executorResponses: executors.length, records }));
} finally { session.dispose(); }
