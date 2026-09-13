import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type Model, type Provider } from "@earendil-works/pi-ai";
import { defaultConfig } from "./config.ts";
import { emitMessage, emptyUsage, type Registry } from "./provider.ts";
import { MixtureSession, newState } from "./session.ts";

test("concurrent reviewers cannot reserve the same remaining spend allowance", async () => {
	const preset = defaultConfig().presets.default;
	preset.lead = "fixture/lead";
	preset.writer = { model: "fixture/writer", thinking: "off" };
	preset.reviewers = [0, 1].map(index => ({ model: `fixture/reviewer${index}`, thinking: "off" }));
	preset.limits.reviewerMaxTokens = 10;
	preset.limits.maxCostUsd = 0.015;
	preset.limits.catchUpMs = 1000;
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const first = new Promise<void>(resolve => { started = resolve; });
	const requested: string[] = [];
	const find: Registry["find"] = (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1000,
		cost: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 } });
	const provider = { streamSimple: (model: Model<any>) => {
		requested.push(model.id); started();
		const stream = createAssistantMessageEventStream();
		void gate.then(() => emitMessage(stream, { role: "assistant", provider: "fixture", model: model.id, api: "fixture", timestamp: 1, stopReason: "toolUse",
			content: [{ type: "toolCall", id: "review", name: "mixture_review", arguments: { revision: 0, findings: [] } }],
			usage: { ...emptyUsage(), output: 10, totalTokens: 10, cost: { ...emptyUsage().cost, output: 0.01, total: 0.01 } } }));
		return stream;
	} } as Provider;
	const registry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
	const state = newState("default", preset);
	state.origins.delegate = { actor: "lead", synthetic: false };
	const session = new MixtureSession(preset, registry, state, () => ({ available: true, jobs: [] }));
	try {
		await session.control("delegate", { action: "delegate", task: "Inspect fixture", successCriteria: ["No defects"] });
		// The checkpoint admits both reviewers concurrently, but only one reservation fits.
		const review = session.reviews.checkpoint(0, "Final verification");
		await first;
		expect(requested).toHaveLength(1);
		release();
		const result = await review;
		expect(requested).toEqual(["reviewer0"]);
		expect(result.warnings.join("\n")).toContain("estimated-spend limit");
		expect(session.usage.cost.total).toBe(0.01);
		expect(session.takeUsage().cost.total).toBe(0.01);
		expect(session.takeUsage().cost.total).toBe(0);
	} finally { release(); await session.abort(); }
});
