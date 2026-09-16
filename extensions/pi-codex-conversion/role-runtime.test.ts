import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { appendActiveMessage, commitContextTransition, scheduleContextTransition } from "./local-context.ts";
import { defaultConfig } from "../mixture/config.ts";
import { emitMessage, emptyUsage, requestLaneId, type Registry } from "../mixture/provider.ts";
import { MixtureSession, newState } from "../mixture/session.ts";

const model = {
	provider: "fixture", id: "role", name: "role", api: "fixture", baseUrl: "", reasoning: true,
	input: ["text"], contextWindow: 100_000, maxTokens: 4_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant", provider: model.provider, model: model.id, api: model.api, content,
		usage: emptyUsage(), timestamp: Date.now(), stopReason, errorMessage,
	};
}

function streamMessage(value: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	emitMessage(stream, value);
	return stream;
}

function roleSession(reviewerCount: number, registry?: Registry) {
	const preset = structuredClone(defaultConfig().presets.default);
	preset.lead = "fixture/role";
	preset.writer.model = "fixture/role";
	preset.reviewers = Array.from({ length: reviewerCount }, () => ({ model: "fixture/role", thinking: "low" as const }));
	const fallback: Registry = {
		find: () => model,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: () => streamMessage(message([{ type: "text", text: "ok" }])) }) as any,
	};
	const state = newState("fixture", preset);
	const session = new MixtureSession(preset, registry ?? fallback, state);
	session.newRequest("Keep each role's private context isolated.");
	return { preset, state, session };
}

test("role-local windows remain isolated for zero, one, and four reviewers", () => {
	for (const reviewerCount of [0, 1, 4]) {
		const { state } = roleSession(reviewerCount);
		const roles = [state.lead, state.writer, ...state.reviewers];
		expect(roles).toHaveLength(reviewerCount + 2);
		expect(new Set(roles.map(role => role.localContext!.identity.role)).size).toBe(roles.length);
		expect(new Set(roles.map(role => `${role.localContext!.identity.branchId}:${role.localContext!.identity.role}`)).size).toBe(roles.length);

		for (const [index, role] of roles.entries()) {
			role.localContext!.notes.push({ path: "facts", text: `role-${index}-private-sentinel`, createdAt: 1, updatedAt: 1 });
			appendActiveMessage(role.localContext!, { role: "assistant", content: [{ type: "text", text: `window-${index}` }], provider: "fixture", model: "role", api: "fixture", usage: emptyUsage(), stopReason: "stop", timestamp: 1 });
			scheduleContextTransition(role.localContext!);
			commitContextTransition(role.localContext!, { currentTask: { role: "user", content: "Continue", timestamp: 2 } });
		}

		for (const [index, role] of roles.entries()) {
			expect(role.localContext!.notes[0]?.text).toBe(`role-${index}-private-sentinel`);
			expect(role.localContext!.archives).toHaveLength(1);
			for (const [otherIndex, other] of roles.entries()) {
				if (otherIndex !== index) expect(JSON.stringify(other.localContext)).not.toContain(`role-${index}-private-sentinel`);
			}
		}
	}
});

test("role calls preserve provider callbacks without crossing private message windows", async () => {
	const calls: Array<{ context: Context; options: any }> = [];
	let payloadCalls = 0;
	let responseCalls = 0;
	const registry: Registry = {
		find: () => model,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture", baseUrl: "https://fixture.invalid" }),
		getProvider: () => ({ streamSimple: (_model: any, context: Context, options: any) => {
			calls.push({ context: structuredClone(context), options: { ...options } });
			void options.onPayload?.({ fixture: true });
			options.onResponse?.({ status: 200 });
			return streamMessage(message([{ type: "text", text: "done" }]));
		} }) as any,
	};
	const { session, state } = roleSession(1, registry);
	state.lead.localContext!.notes.push({ path: "facts", text: "lead-private", createdAt: 1, updatedAt: 1 });
	state.writer.localContext!.notes.push({ path: "facts", text: "writer-private", createdAt: 1, updatedAt: 1 });
	appendActiveMessage(state.lead.localContext!, { role: "user", content: "lead-window", timestamp: 2 });
	appendActiveMessage(state.writer.localContext!, { role: "user", content: "writer-window", timestamp: 2 });
	const context: Context = { systemPrompt: "fixture", messages: [], tools: [] };
	const options = {
		sessionId: "root", onPayload: () => { payloadCalls++; return { preserved: true }; },
		onResponse: () => { responseCalls++; },
	};
	await (session as any).call("lead", context, options);
	await (session as any).call("writer", context, options);

	expect(calls).toHaveLength(2);
	expect(JSON.stringify(calls[0].context.messages)).toContain("lead-window");
	expect(JSON.stringify(calls[0].context.messages)).not.toContain("writer-window");
	expect(JSON.stringify(calls[1].context.messages)).toContain("writer-window");
	expect(JSON.stringify(calls[1].context.messages)).not.toContain("lead-window");
	expect(payloadCalls).toBe(2);
	expect(responseCalls).toBe(2);
	expect(new Set(calls.map(call => call.options.sessionId)).size).toBe(2);
});

test("context overflow uses bounded summary and overflow lanes while preserving the role checkpoint", async () => {
	const calls: Array<{ context: Context; sessionId: string }> = [];
	let attempt = 0;
	const registry: Registry = {
		find: () => model,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (_model: any, context: Context, options: any) => {
			calls.push({ context: structuredClone(context), sessionId: options.sessionId });
			attempt++;
			if (attempt === 1) return streamMessage(message([], "error", "maximum context length exceeded"));
			if (attempt === 2) return streamMessage(message([{ type: "text", text: "Private context summary sentinel." }]));
			return streamMessage(message([{ type: "text", text: "Recovered." }]));
		} }) as any,
	};
	const { session, state } = roleSession(0, registry);
	state.lead.localContext!.notes.push({ path: "facts", text: "lead-private-sentinel", createdAt: 1, updatedAt: 1 });
	for (let index = 0; index < 4; index++) appendActiveMessage(state.lead.localContext!, { role: "user", content: `old-${index}-${"x".repeat(2_000)}`, timestamp: index + 2 });
	const branchId = state.id;
	const response = await (session as any).call("lead", { systemPrompt: "fixture", messages: [], tools: [] }, { sessionId: "root" });

	expect(response.message).toMatchObject({ stopReason: "stop", content: [{ text: "Recovered." }] });
	expect(calls).toHaveLength(3);
	expect(calls.map(call => call.sessionId)).toEqual([
		requestLaneId("root", branchId, "lead", "ordinary"),
		requestLaneId("root", branchId, "lead", "summary"),
		requestLaneId("root", branchId, "lead", "overflow"),
	]);
	expect(state.lead.summaries).toBe(1);
	expect(state.lead.localContext!.notes[0]?.text).toBe("lead-private-sentinel");
	expect(state.lead.localContext!.archives.length).toBeGreaterThan(0);
	expect(JSON.stringify(calls[1].context.tools ?? [])).toBe("[]");
	expect(session.resourceSessionIds().sort()).toEqual(calls.map(call => call.sessionId).sort());
});
