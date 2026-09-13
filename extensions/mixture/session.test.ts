import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defaultConfig } from "./config.ts";
import { emitMessage, emptyUsage, type Registry } from "./provider.ts";
import { CONTROL, MixtureSession, controlTool, newState } from "./session.ts";

const call = (id: string, name: string, args: Record<string, unknown>): AssistantMessage["content"][number] => ({ type: "toolCall", id, name, arguments: args });
const content = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
function harness(script: AssistantMessage["content"][], stops: AssistantMessage["stopReason"][] = []) {
	const calls: Array<{ model: string; context: Context }> = [];
	const preset = defaultConfig().presets.default; preset.reviewers = [];
	const registry: Registry = {
		find: (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (model, context) => {
			calls.push({ model: model.id, context: structuredClone(context) });
			const content = script.shift(); if (!content) throw new Error("Unexpected inference");
			const stream = createAssistantMessageEventStream();
			emitMessage(stream, { role: "assistant", provider: model.provider, model: model.id, api: model.api, content, usage: { ...emptyUsage(), output: 1, totalTokens: 1 }, timestamp: Date.now(), stopReason: stops.shift() ?? (content.some(block => block.type === "toolCall") ? "toolUse" : "stop") });
			return stream;
		} }) as any,
	};
	const jobs = { sessionId: "root", available: true, jobs: [] as any[] };
	const state = newState("default", preset);
	const session = new MixtureSession(preset, registry, state, () => jobs);
	const context: Context = { systemPrompt: "User rules", messages: [{ role: "user", content: "Fix this", timestamp: 1 }],
		tools: [controlTool, ...["read", "edit", "write", "bash", "subagent", "bg_process"].map(name => ({ name, description: name, parameters: Type.Object({}) }))] };
	const next = () => session.next(context, { sessionId: "root" });
	const finishControl = async (message: AssistantMessage) => {
		const block = message.content.find(block => block.type === "toolCall")!;
		const result = await session.control(block.id, block.arguments as any);
		const toolResult: ToolResultMessage = { role: "toolResult", toolCallId: block.id, toolName: CONTROL, ...result, isError: false, timestamp: Date.now() };
		session.completeTurn([toolResult]);
		return toolResult;
	};
	return { calls, preset, session, state, next, finishControl, jobs, context };
}

test("delegates through normal tool calls, keeps distinct histories, and holds the final", async () => {
	const h = harness([
		[call("delegate", CONTROL, { action: "delegate", task: "Edit the fixture", constraints: ["Preserve unrelated files"], successCriteria: ["Test passes"] })],
		[call("edit", "edit", { path: "fixture", edits: [{ oldText: "old", newText: "new" }] })],
		content("Changed fixture. Test passed."),
		content("Fixed and verified."),
	]);
	h.preset.writer.guidance = "Run focused tests before reporting.";
	await h.finishControl(await h.next());
	expect(h.session.active).toBe("writer");
	expect(h.state.owner).toBe("writer");
	const edit = await h.next();
	expect(edit.content[0]).toMatchObject({ name: "edit" });
	h.session.guard("edit", "edit", {});
	h.session.completeTurn([{ role: "toolResult", toolCallId: "edit", toolName: "edit", content: content("done"), isError: false, timestamp: 1 }]);
	await h.finishControl(await h.next());
	expect(h.session.active).toBe("lead");
	expect(h.state.owner).toBeUndefined();
	const checkpoint = await h.next();
	expect(checkpoint.content[0]).toMatchObject({ name: CONTROL, arguments: { action: "checkpoint" } });
	expect(checkpoint.usage.totalTokens).toBe(0);
	await h.finishControl(checkpoint);
	expect((await h.next()).content).toEqual(content("Fixed and verified."));
	expect(h.calls).toHaveLength(4);
	expect(h.calls[0].context.tools?.map(tool => tool.name)).not.toContain("edit");
	expect(h.calls[1].context.tools?.map(tool => tool.name)).toContain("edit");
	expect(h.calls[1].context.systemPrompt).toContain("Run focused tests before reporting.");
	expect(h.calls[0].context.systemPrompt).not.toContain("Run focused tests before reporting.");
	expect(h.calls[1].context.tools?.map(tool => tool.name)).not.toContain("subagent");
	expect(JSON.stringify(h.state.lead.messages)).toContain("Writer report");
	expect(JSON.stringify(h.state.lead.messages)).not.toContain('"oldText"');
	expect(JSON.stringify(h.state.writer.messages)).toContain("Preserve unrelated files");
	expect(h.session.usage.totalTokens).toBe(4);
});

test("rejects mixed control/mutation batches before any execution", async () => {
	const h = harness([[call("take", CONTROL, { action: "takeover" }), call("bad", "edit", {})]]);
	const result = await h.next();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("only tool");
	expect(h.state.owner).toBeUndefined();
	expect(() => h.session.guard("bad", "edit", {})).toThrow("recorded role origin");
});
test("lead must explicitly acquire the writer lease", async () => {
	const h = harness([[call("bad", "bash", { command: "touch bad" })], [call("take", CONTROL, { action: "takeover" })], [call("good", "bash", { command: "printf ok" })]]);
	expect((await h.next()).stopReason).toBe("error");
	await h.finishControl(await h.next());
	expect(h.state.owner).toBe("lead");
	expect((await h.next()).stopReason).toBe("toolUse");
	expect(() => h.session.guard("good", "bash", { command: "printf ok" })).not.toThrow();
});
test("running jobs and unknown background status block writer handoff", async () => {
	const h = harness([[call("delegate", CONTROL, { action: "delegate", task: "Edit", successCriteria: ["Pass"] })]]);
	const message = await h.next();
	h.jobs.jobs.push({ id: "job1", status: "running", cwd: "/fixture", ownerSessionId: "root" });
	await expect(h.finishControl(message)).rejects.toThrow("running jobs: job1");
	expect(h.state.owner).toBeUndefined();
	h.jobs.jobs.length = 0;
	h.jobs.available = false;
	await expect(h.finishControl(message)).rejects.toThrow("did not answer");
	h.jobs.available = true;
	await h.finishControl(message);
	expect(h.state.owner).toBe("writer");
});
test("steering reaches both roles once without resetting delegation limits", async () => {
	const h = harness([[call("delegate", CONTROL, { action: "delegate", task: "Edit", successCriteria: ["Pass"] })], [call("read1", "read", { path: "test" })], content("Done")]);
	await h.finishControl(await h.next());
	h.context.messages.push({ role: "user", content: "Do not change the public API", timestamp: 2 });
	await h.next();
	h.session.completeTurn([{ role: "toolResult", toolCallId: "read1", toolName: "read", content: content("fixture"), isError: false, timestamp: 1 }]);
	await h.next();
	for (const actor of ["lead", "writer"] as const) expect(h.state[actor].messages.filter(message => message.role === "user" && message.content === "Do not change the public API")).toHaveLength(1);
	expect(h.state.brief).toContain("Do not change the public API");
	expect(h.state.delegations).toBe(1);
});
test("failed writer and exhausted writer return incomplete reports to the lead", async () => {
	const failed = harness([[call("delegate", CONTROL, { action: "delegate", task: "Edit", successCriteria: ["Pass"] })], []], ["toolUse", "error"]);
	await failed.finishControl(await failed.next());
	const report = await failed.next();
	expect(report.usage.totalTokens).toBe(1);
	await failed.finishControl(report);
	expect(failed.session.active).toBe("lead");
	expect(JSON.stringify(failed.state.lead.messages)).toContain("Writer failed");
	const limited = harness([[call("delegate", CONTROL, { action: "delegate", task: "Edit", successCriteria: ["Pass"] })], [call("read", "read", { path: "test" })]]);
	limited.preset.limits.writerTurns = 1;
	await limited.finishControl(await limited.next());
	await limited.next();
	limited.session.completeTurn([{ role: "toolResult", toolCallId: "read", toolName: "read", content: content("fixture"), isError: false, timestamp: 1 }]);
	await limited.finishControl(await limited.next());
	expect(JSON.stringify(limited.state.lead.messages)).toContain("Incomplete: writer reached");
	expect(limited.calls).toHaveLength(2);
});
test("truncated tool batches and cancelled calls never grant a lease", async () => {
	const h = harness([[call("take", CONTROL, { action: "takeover" })]], ["length"]);
	expect((await h.next()).stopReason).toBe("error");
	expect(h.state.owner).toBeUndefined();
	const cancelled = harness([content("Must not be called")]);
	cancelled.session.abort();
	expect((await cancelled.next()).stopReason).toBe("aborted");
	expect(cancelled.calls).toHaveLength(0);
});

test("nested agents are blocked even for the lease holder", async () => {
	const h = harness([[call("take", CONTROL, { action: "takeover" })], [call("spawn", "subagent", { task: "edit" })]]);
	await h.finishControl(await h.next());
	expect((await h.next()).stopReason).toBe("error");
	expect(h.state.origins.spawn).toBeUndefined();
});
