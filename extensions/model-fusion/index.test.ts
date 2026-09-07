import { beforeEach, expect, mock, test } from "bun:test";

mock.module("typebox", () => ({ Type: { Object: (properties: unknown) => ({ type: "object", properties }), String: (options: unknown) => ({ type: "string", ...options as object }) } }));

const calls: Array<{ model: any; context: any; options: any }> = [];
let answer: (call: typeof calls[number]) => Promise<any>;
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const response = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage });
const verdict = (kind = "pass") => JSON.stringify({ verdict: kind, findings: kind === "pass" ? [] : ["Incorrect empty input behavior"], checks: ["Run fixture tests"] });
mock.module("@earendil-works/pi-ai/compat", () => ({ completeSimple: async (model: any, context: any, options: any) => {
	const call = { model, context, options };
	calls.push(call);
	return answer(call);
} }));
const { default: extension } = await import("./index.ts");

function harness() {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const messages: any[] = [];
	const entries: any[] = [];
	const notices: string[] = [];
	let activeTools = ["read", "write", "bash", "fusion_escalate"];
	let thinking = "high";
	const ctx: any = {
		model: { provider: "openai-codex", id: "original" },
		signal: new AbortController().signal,
		sessionManager: { getBranch: () => [], getEntries: () => entries.map((entry) => ({ type: "custom", ...entry })) },
		isIdle: () => true,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		ui: { setStatus() {}, notify: (text: string) => notices.push(text) },
	};
	const pi: any = {
		on: (event: string, fn: Function) => handlers.set(event, fn),
		registerCommand: (name: string, spec: any) => commands.set(name, spec),
		registerTool: (spec: any) => tools.set(spec.name, spec),
		getActiveTools: () => activeTools,
		setActiveTools: (value: string[]) => { activeTools = value; },
		getThinkingLevel: () => thinking,
		setThinkingLevel: (value: string) => { thinking = value; },
		setModel: async (model: any) => { ctx.model = model; await handlers.get("model_select")?.({ model }, ctx); return true; },
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
		appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
	};
	extension(pi);
	const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	const command = (name: string) => commands.get("fusion").handler(name, ctx);
	const prompt = async (text = "fix the bug", source = "interactive") => {
		await emit("input", { text, source });
		await emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
		await emit("message_end", { message: { role: "user", content: [{ type: "text", text }] } });
	};
	const finish = async (message = response("Implemented and tested")) => {
		await emit("message_end", { message });
		return emit("turn_end", { message, toolResults: [] });
	};
	const escalate = (signal = ctx.signal) => tools.get("fusion_escalate").execute("id", { problem: "Need independent diagnosis" }, signal, undefined, ctx);
	return { ctx, emit, command, prompt, finish, escalate, messages, entries, notices, tools: () => activeTools, thinking: () => thinking };
}

beforeEach(() => {
	calls.length = 0;
	answer = async (call) => response(call.model.id === "gpt-6-astra" ? "Check empty input and run tests" : verdict());
});

test("disabled is inert; enable keeps native identity and disable restores prior model/thinking", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.prompt(); await h.finish();
	expect(calls).toHaveLength(0);
	expect(h.tools()).not.toContain("fusion_escalate");
	await h.command("on");
	expect(h.ctx.model).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
	expect(h.thinking()).toBe("max");
	await h.command("off");
	expect(h.ctx.model.id).toBe("original");
	expect(h.thinking()).toBe("high");
});

test("both reviewers get main-context tool evidence, not reasoning or images, and pass settles", async () => {
	const h = harness();
	await h.command("on"); await h.prompt();
	await h.emit("message_end", { message: { role: "toolResult", toolName: "bash", toolCallId: "call-1", isError: true, content: [{ type: "text", text: "test failed: empty input" }, { type: "image", data: "private-image" }] } });
	await h.finish(); await h.finish();
	expect(calls).toHaveLength(2);
	for (const call of calls) {
		expect(call.context.tools).toBeUndefined();
		expect(call.context.messages[0].content[0].text).toContain("test failed");
		expect(JSON.stringify(call.context)).not.toContain("private-image");
		expect(call.options.reasoning).toBe(call.model.id.includes("muse-spark") ? "low" : "medium");
	}
	expect(h.messages).toHaveLength(0);
	expect(h.notices.at(-1)).toContain("review passed");
});

test("review context follows Pi's active context and includes new messages without replaying discarded history", async () => {
	const h = harness();
	await h.command("on"); await h.prompt("continue");
	await h.emit("context", { messages: [
		{ role: "user", content: "original full requirement" },
		{ role: "assistant", content: [{ type: "text", text: "earlier analysis summary" }, { type: "thinking", thinking: "private reasoning" }] },
		{ role: "user", content: "continue" },
	] });
	await h.finish();
	const packet = calls[0].context.messages[0].content[0].text;
	expect(packet).toContain("original full requirement");
	expect(packet).toContain("earlier analysis summary");
	expect(packet).toContain("Implemented and tested");
	expect(packet).not.toContain("private reasoning");
	await h.prompt("after compaction");
	await h.emit("context", { messages: [{ role: "user", content: "retained main context" }] });
	await h.finish();
	expect(calls[2].context.messages[0].content[0].text).not.toContain("original full requirement");
});

test("unresolved reviews cause exactly one cheap repair, one Astra advisory, and one final actor continuation", async () => {
	answer = async (call) => response(call.model.id === "gpt-6-astra" ? "Fix the edge case" : verdict("revise"));
	const h = harness();
	await h.command("on"); await h.prompt();
	await h.finish();
	expect(h.messages).toHaveLength(1);
	expect(h.messages[0].options.deliverAs).toBe("followUp");
	await h.finish();
	expect(h.messages).toHaveLength(2);
	await h.finish(); await h.finish();
	expect(calls).toHaveLength(5);
	expect(calls.filter((call) => call.model.id === "gpt-6-astra")).toHaveLength(1);
	expect(h.ctx.model.id).toBe("gpt-5.6-luna");
	expect(h.notices.at(-1)).toContain("bounded review cycle ended");
});

test("tool and automatic escalation share allowance; extension inputs do not reset it, real inputs do", async () => {
	const h = harness();
	await h.command("on"); await h.prompt();
	const result = await h.escalate();
	expect(result.usage).toEqual(usage);
	expect(calls[0].options.reasoning).toBe("low");
	await h.prompt("extension continuation", "extension");
	await expect(h.escalate()).rejects.toThrow("cooldown");
	await h.prompt("new user prompt");
	await h.escalate();
	expect(calls).toHaveLength(2);
});

test("goal continuations reopen review without resetting frontier allowance", async () => {
	const h = harness();
	await h.command("on"); await h.prompt(); await h.escalate(); await h.finish();
	await h.emit("message_start", { message: { role: "custom", customType: "goal-continuation", content: "Continue testing the goal" } });
	await expect(h.escalate()).rejects.toThrow("cooldown");
	await h.finish();
	expect(calls).toHaveLength(5);
	expect(calls.at(-1)?.context.messages[0].content[0].text).toContain("fix the bug");
});

test("goal continuation starts a task when fusion was enabled mid-goal", async () => {
	const h = harness();
	await h.command("on");
	await h.emit("message_start", { message: { role: "custom", customType: "goal-continuation", content: "Finish the fixture" } });
	await h.finish();
	expect(calls).toHaveLength(2);
});

test("terminating goal updates are reviewed and blocked for bounded repairs", async () => {
	answer = async (call) => response(call.model.id === "gpt-6-astra" ? "Verify the fixture" : verdict("revise"));
	const h = harness();
	await h.command("on"); await h.prompt();
	const update = () => h.emit("tool_call", { toolName: "update_goal", input: { status: "complete" } });
	expect((await update()).block).toBe(true);
	expect((await update()).block).toBe(true);
	expect(await update()).toBeUndefined();
	expect(calls).toHaveLength(5);
	expect(h.messages).toHaveLength(0);
});

test("native checkpoint mismatch prevents switching away from a usable model", async () => {
	const h = harness();
	h.ctx.sessionManager.getBranch = () => [{ type: "compaction", details: { kind: "openai-codex-native-compaction", modelKey: "openai-codex:openai-codex-responses:gpt-6-astra" } }];
	await h.command("on");
	expect(h.ctx.model.id).toBe("original");
	expect(h.notices.at(-1)).toContain("Start a new session");
});

const toolBatch = (h: ReturnType<typeof harness>, count: number) => h.emit("turn_end", { message: { ...response("Working"), stopReason: "toolUse" }, toolResults: Array.from({ length: count }, () => ({ role: "toolResult" })) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("background progress counts individual calls and posts delayed passes without triggering turns", async () => {
	const pending: Array<() => void> = [];
	answer = () => new Promise((resolve) => pending.push(() => resolve(response(verdict()))));
	const h = harness();
	await h.command("on"); await h.prompt();
	await toolBatch(h, 9);
	expect(calls).toHaveLength(0);
	await toolBatch(h, 1);
	await flush();
	expect(calls).toHaveLength(2);
	expect(h.messages).toHaveLength(0);
	await toolBatch(h, 3);
	for (const resolve of pending) resolve();
	await flush();
	expect(h.messages[0].options.triggerTurn).toBe(false);
	expect(h.messages[0].message.content).toContain("3 more tool calls");
	expect(h.messages[0].message.details.timing.throughCall).toBe(10);
	expect(h.entries.at(-1).data.phase).toBe("progress");
	answer = async () => response(verdict("revise"));
	await toolBatch(h, 7); await flush();
	expect(h.messages[1].options).toEqual({ deliverAs: "steer", triggerTurn: true });
	expect(h.messages[1].message.content).toContain("may already be addressed");
	await h.finish();
	expect(h.messages[2].message.content).toContain("one cheap repair round");
});

test.each(["input", "session_before_switch", "session_shutdown", "completion", "goal", "abort"])("%s discards pending background results", async (event) => {
	const pending: Array<() => void> = [];
	answer = () => new Promise((resolve) => pending.push(() => resolve(response(verdict("revise")))));
	const h = harness();
	const controller = new AbortController(); h.ctx.signal = controller.signal;
	await h.command("on"); await h.prompt(); await toolBatch(h, 10); await flush();
	answer = async () => response(verdict());
	if (event === "completion") await h.finish();
	else if (event === "goal") await h.emit("tool_call", { toolName: "update_goal", input: { status: "complete" } });
	else if (event === "abort") controller.abort();
	else if (event === "input") await h.prompt("replacement");
	else await h.emit(event);
	for (const resolve of pending) resolve();
	await flush();
	expect(h.messages).toHaveLength(0);
	expect(calls.slice(0, 2).every((call) => call.options.signal.aborted)).toBe(true);
});

test("fusion persists across reload/resume, preserves prior selection, and respects explicit off", async () => {
	const h = harness();
	await h.command("on");
	await h.emit("session_start", { reason: "reload" });
	expect(h.tools()).toContain("fusion_escalate");
	await h.prompt(); await h.finish(); expect(calls).toHaveLength(2);
	await h.command("off");
	expect(h.ctx.model.id).toBe("original");
	await h.emit("session_start", { reason: "resume" });
	expect(h.tools()).not.toContain("fusion_escalate");
});

test("new prompts reset progress cadence", async () => {
	const h = harness();
	await h.command("on"); await h.prompt();
	await toolBatch(h, 9);
	await h.prompt("different task");
	await toolBatch(h, 1);
	expect(calls).toHaveLength(0);
});

test("missing auth prevents activation without model changes", async () => {
	const h = harness();
	h.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await h.command("on");
	expect(h.ctx.model.id).toBe("original");
	expect(h.notices.at(-1)).toContain("Authentication unavailable");
});

test("manual model selection disables fusion without restoring over the user's choice", async () => {
	const h = harness();
	await h.command("on"); await h.prompt();
	h.ctx.model = { provider: "openai", id: "user-choice" };
	await h.emit("model_select");
	await h.finish();
	await h.command("off");
	expect(h.ctx.model.id).toBe("user-choice");
	expect(calls).toHaveLength(0);
});

test("aborted/error/truncated responses are not reviewed", async () => {
	const h = harness();
	await h.command("on"); await h.prompt();
	for (const stopReason of ["error", "aborted", "length", "toolUse"]) await h.finish({ ...response("draft"), stopReason });
	expect(calls).toHaveLength(0);
});

test("partial failure is visibly degraded and all failed reviewers call frontier", async () => {
	const h = harness();
	await h.command("on"); await h.prompt();
	answer = async (call) => {
		if (call.model.id.includes("glm")) throw new Error("offline");
		return response(verdict());
	};
	await h.finish();
	expect(h.notices.at(-1)).toContain("degraded");
	await h.prompt("next");
	answer = async (call) => {
		if (call.model.id !== "gpt-6-astra") return response("malformed");
		return response("Do not claim successful verification");
	};
	await h.finish();
	expect(h.messages).toHaveLength(1);
	expect(calls.at(-1)?.model.id).toBe("gpt-6-astra");
});

test("queued user input is not reviewed until delivered, and direct RPC steering resets allowance", async () => {
	const h = harness();
	await h.command("on"); await h.prompt(); await h.escalate();
	await h.emit("input", { text: "queued", source: "rpc" });
	await h.finish();
	expect(calls).toHaveLength(1);
	await h.emit("message_start", { message: { role: "user", content: "queued" } });
	await h.escalate();
	await h.emit("message_start", { message: { role: "user", content: "direct RPC steer" } });
	await h.escalate();
	expect(calls).toHaveLength(3);
});

test("superseded follow-up advice is excluded from model context", async () => {
	answer = async () => response(verdict("revise"));
	const h = harness();
	await h.command("on"); await h.prompt(); await h.finish();
	const message = { role: "custom", ...h.messages[0].message };
	expect((await h.emit("context", { messages: [message] })).messages).toHaveLength(1);
	await h.prompt("new task");
	expect((await h.emit("context", { messages: [message] })).messages).toHaveLength(0);
});

test("failed reload retains enabled configuration and the current model", async () => {
	const h = harness();
	await h.command("on");
	h.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await h.command("reload");
	expect(h.ctx.model.id).toBe("gpt-5.6-luna");
	await h.command("status");
	expect(h.notices.at(-1)).toContain("Fusion on");
});

test.each(["input", "session_before_switch", "session_before_tree", "session_shutdown", "abort"])("%s cancels pending review and discards late results", async (event) => {
	const pending: Array<() => void> = [];
	answer = (call) => new Promise((resolve) => pending.push(() => resolve(response(verdict("revise")))));
	const h = harness();
	const controller = new AbortController();
	h.ctx.signal = controller.signal;
	await h.command("on"); await h.prompt();
	const finishing = h.finish();
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(calls).toHaveLength(2);
	if (event === "abort") controller.abort();
	else if (event === "input") await h.prompt("replacement");
	else await h.emit(event);
	await finishing;
	for (const complete of pending) complete();
	await Promise.resolve();
	expect(h.messages).toHaveLength(0);
	expect(calls.every((call) => call.options.signal.aborted)).toBe(true);
});
