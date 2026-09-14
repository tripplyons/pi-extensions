import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { defaultConfig } from "./config.ts";
import { addUsage, emitMessage, emptyUsage, type Registry, type RoleStreamOptions } from "./provider.ts";
import { CONTROL, controlTool, MixtureSession, newState } from "./session.ts";

test("serious findings keep the final-correction loop active; rejected candidates stay hidden and are charged once", async () => {
	const preset = defaultConfig().presets.default;
	preset.lead = "openai-codex/lead"; preset.writer.model = "openai-codex/writer";
	preset.reviewers = [{ model: "openai-codex/reviewer", thinking: "low" }];
	let leadCalls = 0; let reviewCalls = 0;
	const roleOptions: RoleStreamOptions[] = [];
	const registry: Registry = {
		find: (provider, id) => ({ provider, id, api: "fixture", name: id, baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (model, _context, options) => {
			roleOptions.push(options ?? {});
			const reviewing = model.id === "reviewer";
			if (reviewing) reviewCalls++; else leadCalls++;
			const message: AssistantMessage = { role: "assistant", api: "fixture", provider: "fixture", model: model.id, timestamp: Date.now(),
				usage: { ...emptyUsage(), input: 1, totalTokens: 1 }, stopReason: reviewing ? "toolUse" : "stop",
				content: reviewing ? [{ type: "toolCall", id: `review_${reviewCalls}`, name: "mixture_review", arguments: { revision: 0,
					findings: [{ id: "persistent", severity: "blocker", summary: "Verification is still missing" }] } }]
					: [{ type: "text", text: `Candidate ${leadCalls}` }],
			};
			const stream = createAssistantMessageEventStream(); emitMessage(stream, message); return stream;
		} }) as any,
	};
	const state = newState("default", preset);
	state.delegations = 1;
	const session = new MixtureSession(preset, registry, state, () => ({ available: true, sessionId: "root", jobs: [] }));
	const context = { messages: [{ role: "user" as const, content: "Finish", timestamp: 1 }], tools: [controlTool] };
	const visible: AssistantMessage[] = [];
	const billed = emptyUsage();
	try {
		for (let turn = 0; turn < 4; turn++) {
			const message = await session.next(context, { sessionId: "root", serviceTier: "priority" } as RoleStreamOptions);
			visible.push(message); addUsage(billed, message.usage);
			const call = message.content.find(block => block.type === "toolCall");
			expect(call?.name).toBe(CONTROL);
			const output = await session.control(call!.id, call!.arguments as any);
			addUsage(billed, output.usage);
			const result: ToolResultMessage = { role: "toolResult", toolName: CONTROL, toolCallId: call!.id, ...output, timestamp: Date.now(), isError: false };
			session.completeTurn([result], message);
		}
		expect(leadCalls).toBe(4);
		expect(reviewCalls).toBe(4);
		expect(roleOptions).toHaveLength(8);
		expect(roleOptions.every(options => options.serviceTier === "priority")).toBe(true);
		expect(state.finalCorrections).toBe(4);
		expect(visible.every(message => message.content.every(block => block.type === "toolCall"))).toBe(true);
		expect(JSON.stringify(state.lead.messages)).toContain("Verification is still missing");
		expect(billed.totalTokens).toBe(8);
		expect(session.usage.totalTokens).toBe(8);
		expect(state.receipts.every(receipt => receipt.delivery === "reported")).toBe(true);
	} finally { await session.abort(); }
});
