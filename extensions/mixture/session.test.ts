import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defaultConfig } from "./config.ts";
import { emitMessage, emptyUsage, type Registry, type RoleStreamOptions } from "./provider.ts";
import { newReviewer } from "./review.ts";
import { CONTROL, MixtureSession, controlTool, newState } from "./session.ts";

const call = (id: string, name: string, args: Record<string, unknown>): AssistantMessage["content"][number] => ({ type: "toolCall", id, name, arguments: args });
const content = (value: string): AssistantMessage["content"] => [{ type: "text", text: value }];
function harness(script: AssistantMessage["content"][], stops: AssistantMessage["stopReason"][] = [], errors: Array<string | undefined> = []) {
	const calls: Array<{ model: string; context: Context; options: RoleStreamOptions }> = [];
	const preset = defaultConfig().presets.default; preset.reviewers = [];
	const registry: Registry = {
		find: (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (model, context, options) => {
			calls.push({ model: model.id, context: structuredClone(context), options: { ...options } });
			const content = script.shift(); if (!content) throw new Error("Unexpected inference");
			const stream = createAssistantMessageEventStream();
			const stopReason = stops.shift() ?? (content.some(block => block.type === "toolCall") ? "toolUse" : "stop");
			const errorMessage = errors.shift();
			const tokens = stopReason === "error" && errorMessage ? 0 : 1;
			emitMessage(stream, { role: "assistant", provider: model.provider, model: model.id, api: model.api, content,
				usage: { ...emptyUsage(), output: tokens, totalTokens: tokens }, timestamp: Date.now(), stopReason, errorMessage });
			return stream;
		} }) as any,
	};
	const jobs = { sessionId: "root", available: true, jobs: [] as any[] };
	const state = newState("default", preset);
	const session = new MixtureSession(preset, registry, state, () => jobs);
	const context: Context = { systemPrompt: "User rules", messages: [{ role: "user", content: "Fix this", timestamp: 1 }],
		tools: [controlTool, ...["read", "edit", "write", "bash", "subagent", "bg_process"].map(name => ({ name, description: name, parameters: Type.Object({}) }))] };
	const next = (options: RoleStreamOptions = {}) => session.next(context, { sessionId: "root", ...options });
	const finishControl = async (message: AssistantMessage) => {
		const block = message.content.find(block => block.type === "toolCall")!;
		const result = await session.control(block.id, block.arguments as any);
		const toolResult: ToolResultMessage = { role: "toolResult", toolCallId: block.id, toolName: CONTROL, ...result, isError: false, timestamp: Date.now() };
		session.completeTurn([toolResult]);
		return toolResult;
	};
	return { calls, preset, session, state, next, finishControl, jobs, context };
}

test("the lead defines the initial brief before the writer starts", async () => {
	const h = harness([
		[call("delegate", CONTROL, { action: "delegate", task: "Fix this without changing unrelated files", successCriteria: ["Relevant checks pass"] })],
		content("Implemented and verified."),
	]);
	expect(h.session.resourceSessionIds("root")).toEqual([
		"root/summary",
		`root/mixture/${h.state.id}/lead`,
		`root/mixture/${h.state.id}/writer`,
	]);
	h.preset.writer.model = "openai-codex/gpt-5.6-luna";
	h.session.newRequest("Fix this without changing unrelated files");
	const delegated = await h.next();
	expect(h.calls.map(call => call.model)).toEqual(["gpt-6-astra"]);
	const leadActions = (h.calls[0].context.tools?.find(tool => tool.name === CONTROL)?.parameters as any).properties.action.enum;
	expect(leadActions).toEqual(["delegate", "takeover"]);
	expect(delegated.content[0]).toMatchObject({ name: CONTROL, arguments: { action: "delegate", task: "Fix this without changing unrelated files" } });
	await h.finishControl(delegated);
	expect(h.session.active).toBe("writer");
	await h.next({ serviceTier: "priority" });
	expect(h.calls.map(call => call.model)).toEqual(["gpt-6-astra", "gpt-5.6-luna"]);
	expect(h.calls[1].options.serviceTier).toBe("priority");
});

test("root compaction rebases only the lead context and preserves usage accounting", async () => {
	const h = harness([content("Continued from compacted context.")]);
	h.state.initialized = true;
	h.state.seenUsers = ["stale-user"];
	h.state.lead.messages = [{ role: "user", content: "raw history that root compaction removed", timestamp: 1 }];
	h.state.lead.usage = { ...emptyUsage(), input: 123, totalTokens: 123 };
	h.session.rebaseLeadAfterCompaction("compact-1");
	h.session.reconcile("session restored");
	h.context.messages = [{ role: "user", content: "Compacted root context", timestamp: 2 }];
	await h.next();
	const request = JSON.stringify(h.calls[0].context.messages);
	expect(request).toContain("Compacted root context");
	expect(request).toContain("session restored");
	expect(request).not.toContain("raw history that root compaction removed");
	expect(h.state.rootCompactionId).toBe("compact-1");
	expect(h.state.lead.usage.totalTokens).toBe(124);
});

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
	h.session.completeTurn([{ role: "toolResult", toolCallId: "edit", toolName: "edit", content: content("done"), isError: false, timestamp: 1 }], edit);
	expect(h.state.writerProgress).toEqual(["[Execution revision 1]\n- edit fixture: success — done"]);
	expect(JSON.stringify(h.state.writerProgress)).not.toContain("oldText");
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
	const writerActions = (h.calls[1].context.tools?.find(tool => tool.name === CONTROL)?.parameters as any).properties.action.enum;
	expect(writerActions).toEqual(["report", "escalate"]);
	expect(h.calls[1].context.systemPrompt).toContain("Run focused tests before reporting.");
	expect(h.calls[0].context.systemPrompt).not.toContain("Run focused tests before reporting.");
	expect(h.calls[1].context.tools?.map(tool => tool.name)).not.toContain("subagent");
	expect(JSON.stringify(h.state.lead.messages)).toContain("Writer completion report");
	expect(JSON.stringify(h.state.lead.messages)).not.toContain('"oldText"');
	expect(JSON.stringify(h.state.writer.messages)).toContain("Preserve unrelated files");
	expect(h.session.usage.totalTokens).toBe(4);
	const performance = h.session.performanceStats();
	expect(performance.requests.lead.count).toBe(2);
	expect(performance.requests.writer.count).toBe(2);
	expect(performance.requests.lead.totalMs).toBeGreaterThanOrEqual(0);
	expect(performance.checkpoints["writer-report"].count).toBe(1);
	expect(performance.checkpoints["final-answer"].count).toBe(1);
});

test("the harness rejects a lead final answer before the required writer phase", async () => {
	const h = harness([content("I skipped the writer.")]);
	h.session.newRequest("Complete the task");
	const result = await h.next();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("required writer phase");
	expect(h.state.delegations).toBe(0);
});

test("the harness forces a lead checkpoint after three completed review cycles", async () => {
	const h = harness([
		content("Continue with a narrower phase."),
	]);
	h.preset.reviewers.push({ model: "fixture/reviewer", thinking: "low" });
	h.state.reviewers.push(newReviewer());
	h.state.active = "writer";
	h.state.owner = "writer";
	h.state.delegations = 1;
	h.state.task = "Complete the fixture";
	h.state.lead.messages.push({ role: "user", content: "[Harness writer-progress checkpoint, stale]\nobsolete", timestamp: 1 });
	for (let revision = 1; revision <= 3; revision++) h.state.writerReviewSequences!.push(h.session.reviews.prime(0, `Cycle ${revision}`));
	h.state.reviewers[0].pending = [];
	h.state.reviewers[0].sequence = 3;
	const checkpoint = await h.next();
	expect(h.calls.map(request => request.model)).toEqual(["gpt-6-astra"]);
	expect(h.session.performanceStats().checkpoints["writer-progress"].count).toBe(1);
	expect(h.session.active).toBe("lead");
	expect(h.state.owner).toBeUndefined();
	expect(checkpoint.content[0]).toMatchObject({ name: CONTROL, arguments: { action: "checkpoint" } });
	expect(JSON.stringify(h.state.writer.messages)).toContain("Harness reviewer feedback after 3 scheduled review cycle");
	expect(JSON.stringify(h.state.lead.messages)).toContain("Harness writer-progress checkpoint");
	expect(JSON.stringify(h.state.lead.messages)).not.toContain("obsolete");
	expect(h.state.lead.messages.filter(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Harness writer-progress checkpoint"))).toHaveLength(1);
	expect(h.session.performanceStats().checkpoints["writer-progress"].count).toBe(1);
	expect(h.session.performanceStats().coordination).toMatchObject({ deliveredReviews: 3, leadCheckpoints: 1, escalations: 0 });
	expect(h.state.coordination?.recent.map(event => event.kind)).toEqual(["feedback-delivered", "lead-checkpoint"]);
});

test("a rejected completion audit returns directly to the cheaper writer", async () => {
	const h = harness([[call("review", "mixture_review", { revision: 0, findings: [{ id: "still-broken", severity: "concern", summary: "The correction is incomplete" }] })]]);
	h.preset.reviewers.push({ model: "fixture/reviewer", thinking: "low" });
	h.state.reviewers.push(newReviewer());
	h.state.active = "writer";
	h.state.owner = "writer";
	h.state.delegations = 1;
	h.state.task = "Complete the fixture";
	h.state.brief = "Task: Complete the fixture";
	h.state.origins.report = { actor: "writer", synthetic: false };
	const result = await h.session.control("report", { action: "report", report: "Everything is done" });
	expect(h.session.active).toBe("writer");
	expect(h.state.owner).toBe("writer");
	expect(h.state.writerReportRejections).toBe(1);
	expect(h.state.coordination).toMatchObject({ leadCheckpoints: 0, deliveredReviews: 1 });
	expect(JSON.stringify(h.state.writer.messages)).toContain("Harness rejected the completion report");
	expect(result.content[0]).toMatchObject({ type: "text" });
	expect((result.content[0] as { text: string }).text).toContain("writer remains active");
});

test("three rejected completion reports force renewable lead assessment", async () => {
	const h = harness([[call("review", "mixture_review", { revision: 0, findings: [{ id: "repeated", severity: "concern", summary: "The defect remains" }] })]]);
	h.preset.reviewers.push({ model: "fixture/reviewer", thinking: "low" });
	h.state.reviewers.push(newReviewer());
	h.state.active = "writer";
	h.state.owner = "writer";
	h.state.delegations = 1;
	h.state.task = "Complete the fixture";
	h.state.brief = "Task: Complete the fixture";
	h.state.writerReportRejections = 2;
	h.state.origins.report = { actor: "writer", synthetic: false };
	const result = await h.session.control("report", { action: "report", report: "Everything is done" });
	expect(h.session.active).toBe("lead");
	expect(h.state.owner).toBeUndefined();
	expect(h.state.writerReportRejections).toBe(3);
	expect(h.state.coordination).toMatchObject({ leadCheckpoints: 1, deliveredReviews: 0 });
	expect(JSON.stringify(h.state.lead.messages)).toContain("three rejected completion reports");
	expect((result.content[0] as { text: string }).text).toContain("third rejected completion report");
});

test("lead takeover mutations request concurrent review", async () => {
	const h = harness([[call("review", "mixture_review", { revision: 1, findings: [] })]]);
	h.preset.reviewers.push({ model: "fixture/reviewer", thinking: "low" });
	h.state.reviewers.push(newReviewer());
	h.state.active = "lead";
	h.state.owner = "lead";
	h.state.origins.fix = { actor: "lead", synthetic: false };
	const message: AssistantMessage = { role: "assistant", provider: "fixture", model: "lead", api: "fixture", content: [call("fix", "edit", { path: "fixture" })], usage: emptyUsage(), timestamp: 1, stopReason: "toolUse" };
	h.session.completeTurn([{ role: "toolResult", toolCallId: "fix", toolName: "edit", content: content("done"), isError: false, timestamp: 2 }], message);
	expect(h.state.revision).toBe(1);
	expect(h.state.coordination).toMatchObject({ scheduledReviews: 1 });
	await h.session.reviews.freeze();
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
	h.state.delegations = 1;
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
test("lead-to-writer loops do not have a delegation cap", async () => {
	const h = harness([]);
	for (let index = 0; index < 12; index++) {
		const delegate = `delegate-${index}`;
		h.state.origins[delegate] = { actor: "lead", synthetic: true };
		await h.session.control(delegate, { action: "delegate", task: `Pass ${index}`, successCriteria: ["Report"] });
		const report = `report-${index}`;
		h.state.origins[report] = { actor: "writer", synthetic: true };
		await h.session.control(report, { action: "report", report: `Completed pass ${index}` });
	}
	expect(h.state.delegations).toBe(12);
	expect(h.session.active).toBe("lead");
});

test("the lead assesses steering before updating the persistent writer", async () => {
	const h = harness([
		[call("delegate", CONTROL, { action: "delegate", task: "Edit", successCriteria: ["Pass"] })],
		[call("update", CONTROL, { action: "update", message: "Preserve the public API while continuing the current plan." })],
		[call("read1", "read", { path: "test" })],
		content("Done"),
	]);
	await h.finishControl(await h.next());
	h.context.messages.push({ role: "user", content: "Do not change the public API", timestamp: 2 });
	const update = await h.next();
	expect(h.calls.at(-1)?.model).toBe("gpt-6-astra");
	const steeringActions = (h.calls.at(-1)?.context.tools?.find(tool => tool.name === CONTROL)?.parameters as any).properties.action.enum;
	expect(steeringActions).toEqual(["update", "takeover"]);
	expect(update.content[0]).toMatchObject({ name: CONTROL, arguments: { action: "update" } });
	expect(JSON.stringify(h.state.lead.messages)).toContain("user steering requires lead assessment");
	await h.finishControl(update);
	expect(h.session.active).toBe("writer");
	expect(h.state.owner).toBe("writer");
	const read = await h.next();
	h.session.completeTurn([{ role: "toolResult", toolCallId: "read1", toolName: "read", content: content("fixture"), isError: false, timestamp: 1 }], read);
	await h.next();
	expect(h.state.lead.messages.filter(message => message.role === "user" && message.content === "Do not change the public API")).toHaveLength(1);
	expect(JSON.stringify(h.state.writer.messages)).toContain("Preserve the public API");
	expect(h.state.writer.messages.some(message => message.role === "user" && message.content === "Do not change the public API")).toBeFalse();
	expect(h.state.brief).toContain("Preserve the public API");
	expect(h.state.delegations).toBe(1);
});
test("plain lead steering text is converted into an update instead of ending the writer phase", async () => {
	const h = harness([content("Keep the current implementation, but preserve the public API."), content("Done")]);
	h.state.initialized = true;
	h.state.active = "lead";
	h.state.owner = "writer";
	h.state.delegations = 1;
	h.state.task = "Edit";
	const update = await h.next();
	expect(update.content[0]).toMatchObject({ name: CONTROL, arguments: { action: "update", message: "Keep the current implementation, but preserve the public API." } });
	await h.finishControl(update);
	expect(h.session.active).toBe("writer");
	expect(h.state.owner).toBe("writer");
	expect(JSON.stringify(h.state.writer.messages)).toContain("preserve the public API");
});

test("failed writer and exhausted writer return incomplete reports to the lead", async () => {
	const failed = harness([[call("delegate", CONTROL, { action: "delegate", task: "Edit", successCriteria: ["Pass"] })], []], ["toolUse", "error"]);
	await failed.finishControl(await failed.next());
	const report = await failed.next();
	expect(report.usage.totalTokens).toBe(1);
	await failed.finishControl(report);
	expect(failed.session.active).toBe("lead");
	expect(JSON.stringify(failed.state.lead.messages)).toContain("Writer failed");
	expect(failed.session.performanceStats().checkpoints["writer-escalation"].count).toBe(1);
	const limited = harness([[call("delegate", CONTROL, { action: "delegate", task: "Edit", successCriteria: ["Pass"] })], [call("read", "read", { path: "test" })]]);
	limited.preset.limits.writerTurns = 1;
	await limited.finishControl(await limited.next());
	await limited.next();
	limited.session.completeTurn([{ role: "toolResult", toolCallId: "read", toolName: "read", content: content("fixture"), isError: false, timestamp: 1 }]);
	await limited.finishControl(await limited.next());
	expect(JSON.stringify(limited.state.lead.messages)).toContain("Incomplete: writer reached");
	expect(limited.calls).toHaveLength(2);
});
test("a zero-output transient writer failure is retried once before lead escalation", async () => {
	for (const error of ["WebSocket error", "The operation was aborted due to timeout"]) {
		const h = harness([
			[call("delegate", CONTROL, { action: "delegate", task: "Edit", successCriteria: ["Pass"] })],
			[],
			content("Completed after retry."),
		], ["toolUse", "error", "stop"], [undefined, error]);
		await h.finishControl(await h.next());
		const report = await h.next();
		expect(h.calls).toHaveLength(3);
		expect(h.state.writerTurns).toBe(2);
		expect(h.state.writerRetries).toBe(1);
		expect(JSON.stringify(h.state.writer.messages)).toContain("Harness retry after transient provider failure");
		expect(report.content[0]).toMatchObject({ name: CONTROL, arguments: { action: "report" } });
	}
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
	h.state.delegations = 1;
	await h.finishControl(await h.next());
	expect((await h.next()).stopReason).toBe("error");
	expect(h.state.origins.spawn).toBeUndefined();
});
