import { expect, test } from "bun:test";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { convertTools as convertGoogleTools } from "@earendil-works/pi-ai/api/google-shared";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { Value } from "typebox/value";
import { createAssistantMessageEventStream, type Context, type Tool } from "@earendil-works/pi-ai";
import { defaultConfig } from "./config.ts";
import { emitMessage, emptyUsage, type Registry } from "./provider.ts";
import { CONTROL, ControlParams, controlTool, MixtureSession, newState } from "./session.ts";

const schema = controlTool.parameters as any;
const controlProperties = Object.keys(schema.properties);
const branch = (value: any, action: string) => value.anyOf.find((candidate: any) => candidate.properties?.action?.enum?.includes(action));
const delegate = (value: any) => branch(value, "delegate");
const continuation = {
	action: "delegate", phaseId: "phase-1", task: "Current step", nextAction: "Run the focused check",
	successCriteria: ["The check passes"], constraints: ["Do not commit"], acceptedEvidence: ["Initial check passed"],
	immediateAction: { tool: "bash", description: "Run the regression" },
};
const assessment = { action: "assess", phaseId: "phase-1", assessment: "progress", evidence: "Regression passes" };
function expectFullControls(value: any) {
	expect(Value.Check(value, continuation)).toBe(true);
	expect(Value.Check(value, assessment)).toBe(true);
	expect(Value.Check(value, { action: "takeover", phaseId: "phase-1" })).toBe(true);
	for (const field of ["task", "nextAction", "successCriteria"]) {
		const missing: Record<string, unknown> = { ...continuation };
		delete missing[field];
		expect(Value.Check(value, missing)).toBe(false);
	}
}
function expectConditionalRequirements(value: any) {
	expect(value.type).toBe("object");
	expect(Object.keys(value.properties)).toEqual(controlProperties);
	expect(value.required).toEqual(["action"]);
	expect(delegate(value).required).toEqual(["action", "task", "nextAction", "successCriteria"]);
	expect(branch(value, "assess").required).toEqual(["action", "phaseId", "assessment", "evidence"]);
	expect(branch(value, "update").required).toEqual(["action", "message"]);
	for (const action of ["report", "escalate", "pause"]) expect(branch(value, action).required).toEqual(["action", "report"]);
	for (const candidate of value.anyOf) expect(candidate.additionalProperties).not.toBe(false);
	expect(Value.Check(value, { action: "delegate", task: "Current step", nextAction: "Run the focused check", successCriteria: ["The check passes"] })).toBe(true);
	expect(Value.Check(value, { action: "assess" })).toBe(false);
	expect(Value.Check(value, { action: "report" })).toBe(false);
	expectFullControls(value);
}
function expectRoleSchema(value: any, actions: readonly string[], required: Record<string, string[]>) {
	expect(value.type).toBe("object");
	expect(Object.keys(value.properties)).toEqual(controlProperties);
	expect(value.properties.action.enum).toEqual(actions);
	expect(value.required).toEqual(["action"]);
	for (const action of actions) expect(branch(value, action).required).toEqual(required[action]);
}
function model(api: string, provider: string, id = "probe") {
	return { id, name: id, api, provider, baseUrl: "https://example.test/v1", reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1 } as any;
}
const context = { messages: [{ role: "user" as const, content: "Schema probe", timestamp: 0 }], tools: [controlTool] };
async function payloadFrom(factory: any, options: Record<string, unknown>, modelValue: any, tool = controlTool) {
	let payload: any;
	await factory(modelValue, { ...context, tools: [tool] }, { ...options, onPayload: (value: unknown) => { payload = value; throw new Error("Stop after schema capture"); } }).result();
	return payload;
}

test("registered control schema requires delegation fields without burdening other actions", () => {
	expectConditionalRequirements(schema);
	const valid = { action: "delegate", task: "Current step", nextAction: "Run the focused check", successCriteria: ["The check passes"] };
	expect(Value.Check(ControlParams, valid)).toBe(true);
	for (const missing of ["task", "nextAction", "successCriteria"]) {
		const invalid = { ...valid } as Record<string, unknown>;
		delete invalid[missing];
		expect(Value.Check(ControlParams, invalid)).toBe(false);
	}
	expect(Value.Check(ControlParams, { ...valid, task: "" })).toBe(false);
	expect(Value.Check(ControlParams, { ...valid, nextAction: "" })).toBe(false);
	expect(Value.Check(ControlParams, { ...valid, successCriteria: [] })).toBe(false);
	expect(Value.Check(ControlParams, { ...valid, successCriteria: [""] })).toBe(false);
	expect(Value.Check(ControlParams, assessment)).toBe(true);
	expect(Value.Check(ControlParams, { action: "update", message: "Continue" })).toBe(true);
	expect(Value.Check(ControlParams, { action: "takeover" })).toBe(true);
	expect(Value.Check(ControlParams, { action: "checkpoint", checkpoint: "checkpoint-1" })).toBe(true);
	for (const action of ["report", "escalate", "pause"]) {
		expect(Value.Check(ControlParams, { action, report: "Completed evidence" })).toBe(true);
		expect(Value.Check(ControlParams, { action })).toBe(false);
	}
});

test("provider serializers preserve the root control properties and supported conditional rules", async () => {
	const googleSchema = (convertGoogleTools([controlTool])![0].functionDeclarations[0] as any).parametersJsonSchema;
	expectConditionalRequirements(googleSchema);
	expectConditionalRequirements((convertResponsesTools([controlTool])[0] as any).parameters);

	const completionsPayload = await payloadFrom(streamCompletions, { apiKey: "probe" }, model("openai-completions", "openrouter"));
	expectConditionalRequirements(completionsPayload.tools[0].function.parameters);

	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "probe" } })).toString("base64url")}.sig`;
	const codexPayload = await payloadFrom(streamCodex, { apiKey: token, transport: "sse" }, model("openai-codex-responses", "openai-codex", "gpt-5.6-luna"));
	expectConditionalRequirements(codexPayload.tools[0].parameters);
});

async function captureRoleTools(): Promise<Tool[]> {
	const tools: Tool[] = [];
	const preset = defaultConfig().presets.default;
	preset.reviewers = [];
	const registry: Registry = {
		find: (provider, id) => ({ ...model("fixture", provider, id), provider, reasoning: true, maxTokens: 20_000 }),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (selected: any, request: Context) => {
			tools.push(request.tools!.find(tool => tool.name === CONTROL)!);
			const stream = createAssistantMessageEventStream();
			const initial = tools.length === 1;
			emitMessage(stream, { role: "assistant", provider: selected.provider, model: selected.id, api: selected.api,
				content: initial ? [{ type: "toolCall", id: "delegate", name: CONTROL, arguments: {
					action: "delegate", task: "Current step", nextAction: "Run the check", successCriteria: ["Check passes"],
				} }] : [{ type: "text", text: "Captured" }],
				usage: emptyUsage(), timestamp: 0, stopReason: initial ? "toolUse" : "stop" });
			return stream;
		} }) as any,
	};
	const state = newState("default", preset);
	const session = new MixtureSession(preset, registry, state, () => ({ sessionId: "schema-test", available: true, jobs: [] }));
	const lead = await session.next(context, {});
	const call = lead.content.find(block => block.type === "toolCall")!;
	const result = await session.control(call.id, call.arguments as any);
	session.completeTurn([{ role: "toolResult", toolCallId: call.id, toolName: CONTROL, ...result, isError: false, timestamp: 0 }]);
	const writer = await session.next(context, {});
	expect(writer.content[0]).toMatchObject({ type: "toolCall", name: CONTROL, arguments: { action: "report" } });
	return tools;
}

test("role-filtered control schemas survive each provider serializer", async () => {
	const tools = await captureRoleTools();
	expect(tools).toHaveLength(2);
	const roles = [
		{ actions: ["delegate"], required: { delegate: ["action", "task", "nextAction", "successCriteria"] } },
		{ actions: ["report", "escalate"], required: { report: ["action", "report"], escalate: ["action", "report"] } },
	] as const;
	for (const [index, role] of roles.entries()) {
		const tool = tools[index];
		const roleSchema = tool.parameters as any;
		expectRoleSchema(roleSchema, role.actions, role.required);

		const serialized = [
			(convertGoogleTools([tool])![0].functionDeclarations[0] as any).parametersJsonSchema,
			(convertResponsesTools([tool])[0] as any).parameters,
			(await payloadFrom(streamCompletions, { apiKey: "probe" }, model("openai-completions", "openrouter"), tool)).tools[0].function.parameters,
		];
		const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "probe" } })).toString("base64url")}.sig`;
		serialized.push((await payloadFrom(streamCodex, { apiKey: token, transport: "sse" }, model("openai-codex-responses", "openai-codex", "gpt-5.6-luna"), tool)).tools[0].parameters);
		for (const converted of serialized) expectRoleSchema(converted, role.actions, role.required);

		const anthropicSchema = (await payloadFrom(streamAnthropic, { apiKey: "probe" }, model("anthropic-messages", "anthropic", "claude-sonnet"), tool)).tools[0].input_schema;
		expect(anthropicSchema.properties.action.enum).toEqual(role.actions);
		expect(anthropicSchema.required).toEqual(["action"]);
		if (index === 0) {
			expect(Value.Check(anthropicSchema, continuation)).toBe(true);
			expect(anthropicSchema.properties.task).toMatchObject({ minLength: 1 });
			expect(anthropicSchema.properties.nextAction).toMatchObject({ minLength: 1, maxLength: 4_000 });
			expect(anthropicSchema.properties.successCriteria).toMatchObject({ minItems: 1 });
		}
	}
});

test("Anthropic serialization keeps the usable fallback and documents conditional runtime enforcement", async () => {
	const payload = await payloadFrom(streamAnthropic, { apiKey: "probe" }, model("anthropic-messages", "anthropic", "claude-sonnet"));
	const parameters = payload.tools[0].input_schema;
	expect(parameters.type).toBe("object");
	expect(Object.keys(parameters.properties)).toEqual(controlProperties);
	expect(parameters.required).toEqual(["action"]);
	expect(parameters.anyOf).toBeUndefined();
	expect(parameters.properties.task).toMatchObject({ minLength: 1 });
	expect(parameters.properties.nextAction).toMatchObject({ minLength: 1, maxLength: 4_000 });
	expect(parameters.properties.successCriteria).toMatchObject({ minItems: 1, items: { minLength: 1, maxLength: 2_000 } });
});
