import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defaultConfig } from "./config.ts";
import { emitMessage, emptyUsage, type Registry, type RoleStreamOptions } from "./provider.ts";
import { newReviewer } from "./review.ts";
import { assessPhase, delegatePhase } from "./phase.ts";
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
		tools: [controlTool, ...["read", "edit", "write", "bash", "subagent", "bg_process", "get_goal", "create_goal", "update_goal", "init_experiment", "run_experiment", "log_experiment", "imagegen"].map(name => ({ name, description: name, parameters: Type.Object({}) }))] };
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
		[call("delegate", CONTROL, { action: "delegate", task: "Fix this without changing unrelated files", nextAction: "Inspect the failing behavior, fix it, and run focused checks", successCriteria: ["Relevant checks pass"] })],
		content("Implemented and verified."),
	]);
	expect(h.session.resourceSessionIds("root")).toEqual([
		"root/summary",
		`root/mixture/${h.state.id}/lead`,
		`root/mixture/${h.state.id}/writer`,
	]);
	h.preset.writer.model = "openai-codex/gpt-5.6-luna";
	h.preset.limits.requestTimeoutMs = 111_000;
	h.preset.limits.writerRequestTimeoutMs = 222_000;
	h.session.newRequest("Fix this without changing unrelated files");
	const delegated = await h.next();
	expect(h.calls.map(call => call.model)).toEqual(["gpt-6-astra"]);
	const leadActions = (h.calls[0].context.tools?.find(tool => tool.name === CONTROL)?.parameters as any).properties.action.enum;
	expect(leadActions).toEqual(["delegate", "assess", "takeover"]);
	expect(delegated.content[0]).toMatchObject({ name: CONTROL, arguments: { action: "delegate", task: "Fix this without changing unrelated files" } });
	const delegatedResult = await h.finishControl(delegated);
	expect((delegatedResult.details as any).usageSummary).toBeUndefined();
	expect((delegatedResult.details as any).controlSummary).toMatchObject({ phaseId: h.state.phase!.id, attempt: 1, findings: { total: 0, serious: 0 } });
	expect(JSON.stringify((delegatedResult.details as any).controlSummary).length).toBeLessThan(1_000);
	expect(h.session.active).toBe("writer");
	await h.next({ serviceTier: "priority" });
	expect(h.calls.map(call => call.model)).toEqual(["gpt-6-astra", "gpt-5.6-luna"]);
	expect(h.calls[0].options.timeoutMs).toBe(111_000);
	expect(h.calls[1].options.timeoutMs).toBe(222_000);
	expect(h.calls[1].options.serviceTier).toBe("priority");
});

test("role-filtered control schemas require delegate fields without burdening other actions", async () => {
	const h = harness([[call("delegate", CONTROL, { action: "delegate", task: "Complete the current step", nextAction: "Run the focused check", successCriteria: ["The check passes"] })], content("Writer report")]);
	h.session.newRequest("Complete the current step");
	const lead = await h.next();
	const leadSchema = h.calls[0].context.tools?.find(tool => tool.name === CONTROL)?.parameters as any;
	expect(leadSchema).toMatchObject({ type: "object", required: ["action"] });
	expect(leadSchema.anyOf.find((branch: any) => branch.properties.action.enum.includes("delegate")).required).toEqual(["action", "task", "nextAction", "successCriteria"]);
	expect(leadSchema.anyOf.find((branch: any) => branch.properties.action.enum.includes("assess")).required).toEqual(["action"]);
	await h.finishControl(lead);
	await h.next();
	const writerSchema = h.calls[1].context.tools?.find(tool => tool.name === CONTROL)?.parameters as any;
	expect(writerSchema).toMatchObject({ type: "object", required: ["action"] });
	expect(writerSchema.anyOf).toBeUndefined();
	expect(writerSchema.properties.action.enum).toEqual(["report", "escalate"]);
	expect((writerSchema.required as string[])).not.toContain("task");
	expect((writerSchema.required as string[])).not.toContain("nextAction");
	expect((writerSchema.required as string[])).not.toContain("successCriteria");
});

test("routes session controls to the lead and arbitrary effectful tools to the lease holder", async () => {
	const h = harness([
		[call("delegate", CONTROL, { action: "delegate", task: "Optimize", nextAction: "Run the benchmark and measure a bounded change", successCriteria: ["Benchmark improves"] })],
		content("Working"),
	]);
	await h.finishControl(await h.next());
	const leadTools = h.calls[0].context.tools?.map(tool => tool.name) ?? [];
	expect(leadTools).toEqual(expect.arrayContaining(["get_goal", "create_goal", "update_goal"]));
	expect(leadTools).not.toEqual(expect.arrayContaining(["init_experiment", "run_experiment", "log_experiment", "imagegen"]));
	await h.next();
	const writerTools = h.calls[1].context.tools?.map(tool => tool.name) ?? [];
	expect(writerTools).toEqual(expect.arrayContaining(["get_goal", "init_experiment", "run_experiment", "log_experiment", "imagegen"]));
	expect(writerTools).not.toEqual(expect.arrayContaining(["create_goal", "update_goal", "subagent"]));

	h.state.origins.goal = { actor: "lead", synthetic: false };
	h.session.completeTurn([{ role: "toolResult", toolCallId: "goal", toolName: "create_goal", content: content("created"), isError: false, timestamp: 1 }]);
	expect(h.state.revision).toBe(0);
	h.state.origins.experiment = { actor: "writer", synthetic: false };
	h.session.completeTurn([{ role: "toolResult", toolCallId: "experiment", toolName: "run_experiment", content: content("passed"), isError: false, timestamp: 1 }]);
	expect(h.state.revision).toBe(1);
});

test("an immediate action blocks other writer tools until the named tool is accepted", async () => {
	const h = harness([
		[call("delegate", CONTROL, { action: "delegate", task: "Reproduce the failure", nextAction: "Run the exact test", immediateAction: { tool: "bash", description: "Run the seed-12 reproduction before reading more source" }, successCriteria: ["Failure reproduced"] })],
	]);
	await h.finishControl(await h.next());
	h.state.origins["read-first"] = { actor: "writer", synthetic: false };
	expect(() => h.session.guard("read-first", "read", {})).toThrow("requires bash first");
	expect(h.state.immediateAction?.tool).toBe("bash");
	h.state.origins["bash-first"] = { actor: "writer", synthetic: false };
	expect(() => h.session.guard("bash-first", "bash", {})).not.toThrow();
	expect(h.state.immediateAction).toBeUndefined();
	expect(() => h.session.guard("read-first", "read", {})).not.toThrow();
});

test("periodic review counts only writer batches that advance execution revision", async () => {
	const h = harness([[call("review", "mixture_review", { revision: 2, findings: [] })]]);
	h.preset.reviewers.push({ model: "fixture/reviewer", thinking: "low" });
	h.preset.limits.reviewEveryBatches = 2;
	h.state.reviewers.push(newReviewer());
	h.state.active = "writer";
	h.state.owner = "writer";
	const result = (id: string, toolName: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName, content: content("ok"), isError: false, timestamp: 1 });
	for (const id of ["read-1", "read-2", "read-3"]) {
		h.state.origins[id] = { actor: "writer", synthetic: false };
		h.session.completeTurn([result(id, "read")], { role: "assistant", provider: "fixture", model: "writer", api: "fixture", content: [call(id, "read", {})], stopReason: "toolUse", usage: emptyUsage(), timestamp: 1 });
	}
	expect(h.state.writerBatches).toBe(0);
	expect(h.state.coordination?.scheduledReviews).toBe(0);
	for (const id of ["edit-1", "edit-2"]) {
		h.state.origins[id] = { actor: "writer", synthetic: false };
		h.session.completeTurn([result(id, "edit")], { role: "assistant", provider: "fixture", model: "writer", api: "fixture", content: [call(id, "edit", {})], stopReason: "toolUse", usage: emptyUsage(), timestamp: 1 });
	}
	await new Promise(resolve => setImmediate(resolve));
	await h.session.reviews.freeze();
	expect(h.state.writerBatches).toBe(2);
	expect(h.state.coordination?.scheduledReviews).toBe(1);
	expect(h.calls).toHaveLength(1);
	expect(JSON.stringify(h.calls[0].context.messages)).toContain("read-1");
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
		[call("delegate", CONTROL, { action: "delegate", task: "Edit the fixture", nextAction: "Replace old with new and run the fixture test", constraints: ["Preserve unrelated files"], successCriteria: ["Test passes"] })],
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
	expect(h.calls[1].context.systemPrompt).toContain("Do not author or materially alter the acceptance oracle");
	expect(h.calls[0].context.systemPrompt).toContain("Keep ownership of correctness-critical acceptance-oracle design");
	expect(h.calls[0].context.systemPrompt).not.toContain("Run focused tests before reporting.");
	expect(h.calls[1].context.tools?.map(tool => tool.name)).not.toContain("subagent");
	expect(JSON.stringify(h.state.lead.messages)).toContain("Writer completion report");
	expect(JSON.stringify(h.state.lead.messages)).toContain("[Recorded writer execution evidence]");
	expect(JSON.stringify(h.state.lead.messages)).toContain("edit fixture: success — done");
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

test("the lead answers requests that require no writer work", async () => {
	const h = harness([content("Hi!")]);
	h.session.newRequest("hi");
	const checkpoint = await h.next();
	expect(checkpoint.content[0]).toMatchObject({ name: CONTROL, arguments: { action: "checkpoint" } });
	await h.finishControl(checkpoint);
	const result = await h.next();
	expect(result.content).toEqual(content("Hi!"));
	expect(result.stopReason).toBe("stop");
	expect(h.state.delegations).toBe(0);
});

test("a direct status question is answered without converting it into writer steering", async () => {
	const answer = "Nothing external is blocking; only the diagnostic handoff is pending.";
	const h = harness([content(answer)]);
	h.context.messages = [{ role: "user", content: "what is being waited on right now?", timestamp: 2 }];
	h.state.initialized = true;
	h.state.active = "writer";
	h.state.owner = "writer";
	h.state.delegations = 1;
	h.state.task = "Finish the existing writer task";
	const checkpoint = await h.next();
	const actions = (h.calls[0].context.tools?.find(tool => tool.name === CONTROL)?.parameters as any).properties.action.enum;
	expect(actions).toEqual(["takeover"]);
	expect(checkpoint.content[0]).toMatchObject({ name: CONTROL, arguments: { action: "checkpoint" } });
	expect(JSON.stringify(h.state.lead.messages)).toContain("answer a direct question or status request yourself");
	expect(JSON.stringify(h.state.lead.messages)).not.toContain('"action":"update"');
	expect(h.state.owner).toBe("writer");
	expect(h.state.task).toBe("Finish the existing writer task");
	expect(h.state.delegations).toBe(1);
	expect(h.state.writer.messages).toEqual([]);
	await h.finishControl(checkpoint);
	expect((await h.next()).content).toEqual(content(answer));
	expect(h.state.writer.messages).toEqual([]);
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
	h.state.phase = delegatePhase(undefined, { task: "Complete the fixture", nextAction: "Read the fixture and fix it", successCriteria: ["Fixture passes"] }).phase;
	const priorPhase = structuredClone(h.state.phase);
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
	expect(h.state.phase).toEqual(priorPhase);
	expect(JSON.stringify(h.calls[0].context.messages)).toContain(`Phase ID: ${priorPhase.id}`);
});

test("completion handoffs include only the bounded tail of execution evidence", async () => {
	const h = harness([]);
	h.state.active = "writer";
	h.state.owner = "writer";
	h.state.writerProgress = Array.from({ length: 20 }, (_, index) => `milestone-${index}-${"x".repeat(1_000)}`);
	h.state.origins.report = { actor: "writer", synthetic: false };
	await h.session.control("report", { action: "report", report: "Completed" });
	const handoff = JSON.stringify(h.state.lead.messages);
	expect(handoff).toContain("[Recorded writer execution evidence]");
	expect(handoff).toContain("Earlier execution milestones omitted");
	expect(handoff).not.toContain("milestone-0-");
	expect(handoff).toContain("milestone-19-");
	expect(handoff.length).toBeLessThan(15_000);
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
	const h = harness([[call("delegate", CONTROL, { action: "delegate", task: "Edit", nextAction: "Edit the fixture", successCriteria: ["Pass"] })]]);
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
test("a fresh phase drops findings from the closed phase but preserves reviewer accounting", async () => {
	const h = harness([]);
	h.preset.reviewers.push({ model: "fixture/reviewer", thinking: "low" });
	const reviewer = newReviewer();
	reviewer.calls = 3;
	reviewer.usage = { ...emptyUsage(), output: 7, totalTokens: 7 };
	reviewer.messages.push({ role: "user", content: "Old phase review", timestamp: 1 });
	reviewer.findings.push({ id: "old-scope", reviewer: 0, model: "fixture/reviewer", severity: "concern", summary: "Only applies to the completed phase", revision: 4, alerted: true });
	h.state.reviewers.push(reviewer);
	const oldPhase = delegatePhase(undefined, { task: "Old phase", nextAction: "Finish old work", successCriteria: ["Old work passes"] }).phase;
	h.state.phase = assessPhase(oldPhase, { phaseId: oldPhase.id, assessment: "complete", evidence: "Old work passed" });
	h.state.reviewSummary = "Old unresolved review advice";
	h.state.finalCorrections = 2;
	h.state.origins.fresh = { actor: "lead", synthetic: false };

	await h.session.control("fresh", { action: "delegate", task: "New phase", nextAction: "Inspect the new request", successCriteria: ["New request is reported"] });

	expect(h.state.phase?.id).not.toBe(oldPhase.id);
	expect(reviewer.findings).toEqual([]);
	expect(reviewer.messages).toEqual([]);
	expect(reviewer.pending).toHaveLength(1);
	expect(reviewer.calls).toBe(3);
	expect(reviewer.usage.totalTokens).toBe(7);
	expect(h.state.reviewSummary).toBeUndefined();
	expect(h.state.finalCorrections).toBe(0);
});

test("a continuation retains findings from its current phase", async () => {
	const h = harness([]);
	h.preset.reviewers.push({ model: "fixture/reviewer", thinking: "low" });
	const reviewer = newReviewer();
	reviewer.findings.push({ id: "current-scope", reviewer: 0, model: "fixture/reviewer", severity: "concern", summary: "Still applies", revision: 1, alerted: true });
	h.state.reviewers.push(reviewer);
	const phase = delegatePhase(undefined, { task: "Current phase", nextAction: "Inspect it", successCriteria: ["It passes"] }).phase;
	h.state.phase = assessPhase(phase, { phaseId: phase.id, assessment: "progress", evidence: "The failure was reproduced" });
	h.state.origins.continue = { actor: "lead", synthetic: false };

	await h.session.control("continue", { action: "delegate", phaseId: phase.id, task: "Continue current phase", nextAction: "Apply the correction", successCriteria: ["It passes"] });

	expect(h.state.phase?.id).toBe(phase.id);
	expect(reviewer.findings.map(finding => finding.id)).toEqual(["current-scope"]);
});

test("verified phase completions do not have a delegation cap", async () => {
	const h = harness([]);
	for (let index = 0; index < 12; index++) {
		const delegate = `delegate-${index}`;
		h.state.origins[delegate] = { actor: "lead", synthetic: true };
		await h.session.control(delegate, { action: "delegate", task: `Pass ${index}`, nextAction: "Perform the next independent pass", successCriteria: ["Report"] });
		const report = `report-${index}`;
		h.state.origins[report] = { actor: "writer", synthetic: true };
		await h.session.control(report, { action: "report", report: `Completed pass ${index}` });
		const assessment = `assess-${index}`;
		h.state.origins[assessment] = { actor: "lead", synthetic: false };
		await h.session.control(assessment, { action: "assess", phaseId: h.state.phase!.id, assessment: "complete", evidence: `Pass ${index} meets its acceptance criterion` });
	}
	expect(h.state.delegations).toBe(12);
	expect(h.session.active).toBe("lead");
});

test("the lead assesses steering before updating the persistent writer", async () => {
	const h = harness([
		[call("delegate", CONTROL, { action: "delegate", task: "Edit", nextAction: "Edit the fixture", successCriteria: ["Pass"] })],
		[call("update", CONTROL, { action: "update", message: "Preserve the public API while continuing the current plan." })],
		[call("read1", "read", { path: "test" })],
		content("Done"),
	]);
	await h.finishControl(await h.next());
	const originalPhase = structuredClone(h.state.phase!);
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
	await h.finishControl(await h.next());
	expect(h.state.lead.messages.filter(message => message.role === "user" && message.content === "Do not change the public API")).toHaveLength(1);
	expect(JSON.stringify(h.state.writer.messages)).toContain("Preserve the public API");
	expect(h.state.writer.messages.some(message => message.role === "user" && message.content === "Do not change the public API")).toBeFalse();
	expect(h.state.brief).not.toContain("Preserve the public API");
	expect(h.state.delegations).toBe(1);
	expect(h.state.phase).toMatchObject({ id: originalPhase.id, attempt: 1, failedCorrections: 0,
		constraints: [], updates: [{ attempt: 1, message: "Preserve the public API while continuing the current plan." }] });
	expect(h.state.phase!.assessment).toBeUndefined();
	h.state.origins.assess = { actor: "lead", synthetic: false };
	await h.session.control("assess", { action: "assess", phaseId: originalPhase.id, assessment: "progress", evidence: "The read resolved the fixture contents" });
	h.state.origins.continue = { actor: "lead", synthetic: false };
	await h.session.control("continue", { action: "delegate", phaseId: originalPhase.id, task: "Finish implementation", nextAction: "Edit the private implementation", successCriteria: ["Pass"] });
	expect(h.state.brief).toContain("Lead updates during this phase:");
	expect(h.state.brief).toContain("Attempt 1: Preserve the public API while continuing the current plan.");
	expect(h.state.phase!.constraints).toEqual([]);
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
	const failed = harness([[call("delegate", CONTROL, { action: "delegate", task: "Edit", nextAction: "Edit the fixture", successCriteria: ["Pass"] })], []], ["toolUse", "error"]);
	await failed.finishControl(await failed.next());
	const report = await failed.next();
	expect(report.usage.totalTokens).toBe(1);
	await failed.finishControl(report);
	expect(failed.session.active).toBe("lead");
	expect(JSON.stringify(failed.state.lead.messages)).toContain("Writer failed");
	expect(failed.session.performanceStats().checkpoints["writer-escalation"].count).toBe(1);
	const limited = harness([[call("delegate", CONTROL, { action: "delegate", task: "Edit", nextAction: "Read the fixture before editing", successCriteria: ["Pass"] })], [call("read", "read", { path: "test" })]]);
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
			[call("delegate", CONTROL, { action: "delegate", task: "Edit", nextAction: "Edit the fixture", successCriteria: ["Pass"] })],
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

test("a delegation retries at most once and preserves completed writer work", async () => {
	const h = harness([
		[call("delegate", CONTROL, { action: "delegate", task: "Edit", nextAction: "Write the fixture", successCriteria: ["Pass"] })],
		[],
		[call("write", "write", { path: "fixture", content: "kept" })],
		[],
	], ["toolUse", "error", "toolUse", "error"], [undefined, "timeout", undefined, "timeout"]);
	await h.finishControl(await h.next());
	const write = await h.next();
	h.session.guard("write", "write", { path: "fixture", content: "kept" });
	h.session.completeTurn([{ role: "toolResult", toolCallId: "write", toolName: "write", content: content("written"), isError: false, timestamp: 1 }], write);
	const escalation = await h.next();
	expect(h.calls).toHaveLength(4);
	expect(h.state.writerRetries).toBe(1);
	expect(h.state.revision).toBe(1);
	expect(JSON.stringify(h.state.writer.messages)).toContain("written");
	expect(JSON.stringify(h.state.writer.messages)).toContain("no checkout changes or completed writer history were reverted");
	expect(escalation.content[0]).toMatchObject({ name: CONTROL, arguments: { action: "escalate" } });
	await h.finishControl(escalation);
	expect(JSON.stringify(h.state.lead.messages)).toContain("[Recorded writer execution evidence]");
	expect(JSON.stringify(h.state.lead.messages)).toContain("write fixture: success — written");
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
