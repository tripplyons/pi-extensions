import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { defaultConfig } from "./config.ts";
import { addUsage, emitMessage, emptyUsage, type Registry, type RoleStreamOptions } from "./provider.ts";
import { CONTROL, controlTool, MixtureSession, newState } from "./session.ts";
import { assessPhase, delegatePhase } from "./phase.ts";

function fixture() {
	const preset = defaultConfig().presets.default;
	preset.lead = "openai-codex/lead"; preset.writer.model = "openai-codex/writer";
	preset.reviewers = [{ model: "openai-codex/reviewer", thinking: "low" }];
	let leadCalls = 0; let reviewCalls = 0;
	const reviewContexts: string[] = [];
	const roleOptions: RoleStreamOptions[] = [];
	const registry: Registry = {
		find: (provider, id) => ({ provider, id, api: "fixture", name: id, baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (model, _context, options) => {
			roleOptions.push(options ?? {});
			const reviewing = model.id === "reviewer";
			if (reviewing) { reviewCalls++; reviewContexts.push(JSON.stringify(_context.messages)); } else leadCalls++;
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
	const brief = { task: "Fix foreground interruption", nextAction: "Run the process-boundary check", successCriteria: ["Foreground child stops while persistent jobs survive"] };
	state.phase = delegatePhase(undefined, brief).phase;
	for (let attempt = 0; attempt < 3; attempt++) {
		state.phase = assessPhase(state.phase, { phaseId: state.phase.id, assessment: "stalled", evidence: "Only repeated research; the process-boundary check has not run" });
		if (attempt < 2) state.phase = delegatePhase(state.phase, { ...brief, phaseId: state.phase.id }).phase;
	}
	const session = new MixtureSession(preset, registry, state, () => ({ available: true, sessionId: "root", jobs: [] }));
	session.newRequest("Continue the same task");
	const context = { messages: [{ role: "user" as const, content: "Finish", timestamp: 1 }], tools: [controlTool] };
	return { state, session, context, brief, roleOptions, reviewContexts, counts: () => ({ leadCalls, reviewCalls }) };
}

async function finishControl(session: MixtureSession, message: AssistantMessage, billed = emptyUsage()) {
	const call = message.content.find(block => block.type === "toolCall");
	expect(call?.name).toBe(CONTROL);
	const output = await session.control(call!.id, call!.arguments as any);
	addUsage(billed, output.usage);
	const result: ToolResultMessage = { role: "toolResult", toolName: CONTROL, toolCallId: call!.id, ...output, timestamp: Date.now(), isError: false };
	session.completeTurn([result], message);
	return output;
}

test("repeated serious findings at one checkout revision are disclosed instead of looping forever", async () => {
	const h = fixture();
	const visible: AssistantMessage[] = [];
	const billed = emptyUsage();
	try {
		for (let turn = 0; turn < 3; turn++) {
			const message = await h.session.next(h.context, { sessionId: "root", serviceTier: "priority" } as RoleStreamOptions);
			visible.push(message); addUsage(billed, message.usage);
			const output = await finishControl(h.session, message, billed);
			if (turn < 2) expect((output.content[0] as { text: string }).text).toContain("withheld");
			else expect((output.content[0] as { text: string }).text).toContain("unresolved findings after repeated same-revision reassessment");
		}
		const released = await h.session.next(h.context, { sessionId: "root", serviceTier: "priority" } as RoleStreamOptions);
		const { leadCalls, reviewCalls } = h.counts();
		expect(leadCalls).toBe(3);
		expect(reviewCalls).toBe(3);
		expect(h.reviewContexts.every(context => context.includes(h.brief.successCriteria[0]))).toBe(true);
		expect(h.roleOptions).toHaveLength(6);
		expect(h.roleOptions.every(options => options.serviceTier === "priority")).toBe(true);
		expect(h.state.finalCorrections).toBe(2);
		expect(visible.every(message => message.content.every(block => block.type === "toolCall"))).toBe(true);
		expect(JSON.stringify(released)).toContain("Candidate 3");
		expect(JSON.stringify(released)).toContain("Verification is still missing");
		expect(JSON.stringify(h.state.lead.messages)).toContain("Verification is still missing");
		expect(billed.totalTokens).toBe(6);
		expect(h.session.usage.totalTokens).toBe(6);
		expect(h.state.receipts.every(receipt => receipt.delivery === "reported")).toBe(true);
	} finally { await h.session.abort(); }
});

test("new effectful-tool evidence renews final-review corrections", async () => {
	const h = fixture();
	try {
		for (let turn = 0; turn < 2; turn++) await finishControl(h.session, await h.session.next(h.context, { sessionId: "root" }));
		expect(h.state.finalCorrections).toBe(2);
		h.state.owner = "lead";
		h.state.origins.fix = { actor: "lead", synthetic: false };
		h.session.completeTurn([{ role: "toolResult", toolName: "edit", toolCallId: "fix", content: [{ type: "text", text: "fixed" }], isError: false, timestamp: 1 }]);
		expect(h.state.revision).toBe(1);
		expect(h.state.finalCorrections).toBe(0);
	} finally { await h.session.abort(); }
});
