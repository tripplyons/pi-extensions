import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { harness } from "../../lib/harness.ts";
import contextFolding, { RECORD_TYPE } from "./index.ts";
import { FOLD_EVENT } from "./events.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const assistant = (content: any[], stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop") =>
  ({ role: "assistant", content, api: "a", provider: "p", model: "m", usage, stopReason, timestamp: 0 });
const call = (id: string, name: string, args: object = {}) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, name: string, text: string, details?: unknown) =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], details, isError: false, timestamp: 0 });

function setup() {
  const h = harness();
  const session = SessionManager.inMemory(process.cwd());
  h.ctx.sessionManager = session;
  const folds: any[] = [];
  h.pi.events.on(FOLD_EVENT, (event: any) => folds.push(event));
  contextFolding(h.pi);
  const append = (message: any) => session.appendMessage(message);
  // A finished exchange with two tool cycles, then a current turn.
  const ids = {
    ask: append(user("fix the parser")),
    read: append(assistant([{ type: "text", text: "Reading." }, call("c1", "read", { path: "parser.ts" })])),
    readResult: append(result("c1", "read", `parser source ${"x".repeat(20_000)}`)),
    test: append(assistant([call("c2", "bash", { command: "npm test" })])),
    testResult: append(result("c2", "bash", `FAIL parser.test.ts ${"y".repeat(20_000)}`)),
    done: append(assistant([{ type: "text", text: "Fixed the parser." }])),
    next: append(user("now the lexer")),
    current: "",
  };
  const turn = (calls: any[]) => {
    const message = assistant(calls);
    ids.current = append(message);
    return message;
  };
  const run = (name: string, toolCallId: string, args: object) => h.tools.get(name).execute(toolCallId, args, undefined, undefined, h.ctx);
  // Finish the turn as Pi does: save results, commit the boundary drafts, then start the next turn.
  // Pi drops every draft when one is invalid, which `rejected` simulates.
  const finish = async (message: any, results: any[], { rejected = false } = {}) => {
    for (const item of results) append(item);
    const [returned] = await h.emit("turn_end", { entries: [], message, toolResults: results });
    if (rejected) { await h.emit("turn_start", {}); return returned?.entries ?? []; }
    for (const draft of returned?.entries ?? []) {
      if (draft.type === "custom") session.appendCustomEntry(draft.customType, draft.data);
      else if (draft.type === "context_edit") session.appendContextEdit(draft.targetId, draft.replacement);
      else session.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
    }
    await h.emit("turn_start", {});
    return returned?.entries ?? [];
  };
  const visible = () => session.buildSessionProjection().messages;
  return { h, session, ids, turn, run, finish, visible, folds };
}

test("status lists fold units with refs and excludes the current turn", async () => {
  const { ids, turn, run } = setup();
  turn([call("s1", "context_status")]);
  const status = await run("context_status", "s1", {});
  const text = status.content[0].text;
  expect(text).toContain(`- ${ids.ask} user`);
  expect(text).toContain(`- ${ids.read}..${ids.readResult} assistant + 1 results`);
  expect(text).toContain("[read]: Reading.");
  expect(text).toContain(`- ${ids.test}..${ids.testResult} assistant + 1 results`);
  expect(text).not.toContain(ids.current);
});

test("compress folds a range after the turn and keeps tool pairs valid", async () => {
  const { ids, turn, run, finish, visible, folds } = setup();
  const message = turn([call("k1", "compress")]);
  const reply = await run("compress", "k1", { from: ids.ask, to: ids.testResult, summary: "Parser fixed in parser.ts; npm test failed before the fix." });
  expect(reply.content[0].text).toContain("fold-1 folds 5 entries");
  // Nothing changes until the turn boundary.
  expect(visible()).toHaveLength(8);
  await finish(message, [result("k1", "compress", reply.content[0].text)]);
  const messages = visible();
  expect(messages.map(item => item.role)).toEqual(["assistant", "toolResult", "assistant", "user", "assistant", "toolResult"]);
  expect(messages[0]).toMatchObject({ content: [call("c2", "bash", { command: "npm test" })] });
  expect((messages[1] as any).content[0].text).toContain("[fold-1: 5 entries folded");
  expect((messages[1] as any).content[0].text).toContain("Parser fixed in parser.ts");
  expect(folds).toHaveLength(1);
  expect(folds[0]).toMatchObject({ phase: "folded", fold: "fold-1" });
  expect(folds[0].savedTokens).toBeGreaterThan(9_000);
  expect(folds[0].rewriteTokens).toBeGreaterThan(0);
});

test("entries Pi cannot edit stay visible inside a fold", async () => {
  const { session, ids, turn, run, finish, visible } = setup();
  const shell = session.appendMessage({ role: "bashExecution", command: "ls /tmp", output: "k3an", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 } as any);
  const system = session.appendMessage({ role: "system", content: "Run started.", timestamp: 0 } as any);
  const ask = session.appendMessage(user(`profile the kernel ${"z".repeat(4_000)}`) as any);
  let message = turn([call("s1", "context_status")]);
  const status = (await run("context_status", "s1", {})).content[0].text;
  expect(status).toContain(`- ${shell} bashExecution ~`);
  expect(status).toContain("$ ls /tmp k3an (stays visible)");
  await finish(message, [result("s1", "context_status", "ok")]);
  message = turn([call("k1", "compress")]);
  const reply = await run("compress", "k1", { from: ids.ask, to: ask, summary: "Parser fixed; kernel profiling requested." });
  expect(reply.content[0].text).toContain("2 entries that cannot be edited, such as user shell commands, stay visible.");
  await finish(message, [result("k1", "compress", reply.content[0].text)]);
  expect(visible().map(item => item.role).slice(0, 3)).toEqual(["bashExecution", "system", "user"]);
  expect(JSON.stringify(visible()[2])).toContain("kernel profiling requested");
  // A range with only uneditable entries has nothing to fold.
  message = turn([call("k2", "compress")]);
  await expect(run("compress", "k2", { from: shell, to: system, summary: "x" })).rejects.toThrow("no entries that can be folded");
});

test("compress rejects ranges that split tool pairs, reach the current turn, or do not shrink", async () => {
  const { ids, turn, run } = setup();
  turn([call("k1", "compress")]);
  const attempt = (args: object) => run("compress", "k1", { summary: "short", ...args });
  await expect(attempt({ from: ids.ask, to: ids.read })).rejects.toThrow("answers a call inside the range");
  await expect(attempt({ from: ids.readResult, to: ids.done })).rejects.toThrow("whose call is outside the range");
  await expect(attempt({ from: ids.ask, to: ids.current })).rejects.toThrow("current turn cannot be folded");
  await expect(attempt({ from: ids.done, to: ids.ask })).rejects.toThrow("comes after");
  await expect(attempt({ from: ids.next, to: ids.next, summary: "a much longer summary than the message it replaces" })).rejects.toThrow("not shorter");
});

test("decompress restores nested folds from the outside in", async () => {
  const { ids, turn, run, finish, visible, folds } = setup();
  const original = visible().map(item => JSON.stringify(item));
  let message = turn([call("k1", "compress")]);
  await run("compress", "k1", { from: ids.ask, to: ids.readResult, summary: "Read parser.ts." });
  await finish(message, [result("k1", "compress", "ok")]);
  message = turn([call("k2", "compress")]);
  // The outer fold covers the inner fold's carrier pair and the next tool cycle.
  await run("compress", "k2", { from: ids.read, to: ids.testResult, summary: "Read and tested the parser." });
  await finish(message, [result("k2", "compress", "ok")]);
  message = turn([call("s1", "context_status")]);
  const status = (await run("context_status", "s1", {})).content[0].text;
  expect(status).toContain("fold-1: ");
  expect(status).toContain("inside fold-2");
  await expect(run("decompress", "d1", { fold: "fold-1" })).rejects.toThrow("decompress fold-2 first");
  await expect(run("decompress", "d1", { fold: "fold-9" })).rejects.toThrow("does not exist");
  await run("decompress", "d1", { fold: "fold-2" });
  await finish(message, [result("s1", "context_status", "ok"), result("d1", "decompress", "ok")]);
  expect(visible().some(item => JSON.stringify(item).includes("Read parser.ts."))).toBe(true);
  message = turn([call("d2", "decompress")]);
  await run("decompress", "d2", { fold: "fold-1" });
  await finish(message, [result("d2", "decompress", "ok")]);
  expect(visible().map(item => JSON.stringify(item)).slice(0, original.length)).toEqual(original);
  expect(folds.map(event => [event.phase, event.fold])).toEqual([["folded", "fold-1"], ["folded", "fold-2"], ["restored", "fold-2"], ["restored", "fold-1"]]);
  expect(folds[2].savedTokens).toBeLessThan(0);
  await expect(run("decompress", "d3", { fold: "fold-1" })).rejects.toThrow("already restored");
});

test("fold events wait until Pi commits the fold", async () => {
  const { h, ids, turn, run, finish, folds } = setup();
  let message = turn([call("k1", "compress")]);
  await run("compress", "k1", { from: ids.ask, to: ids.testResult, summary: "Parser fixed." });
  await finish(message, [result("k1", "compress", "ok")], { rejected: true });
  expect(folds).toEqual([]);
  // The ID is free again, and a committed fold at the end of a run reports at settlement.
  message = turn([call("k2", "compress")]);
  await run("compress", "k2", { from: ids.ask, to: ids.testResult, summary: "Parser fixed." });
  const [returned] = await h.emit("turn_end", { entries: [], message, toolResults: [result("k2", "compress", "ok")] });
  expect(folds).toEqual([]);
  for (const draft of returned.entries) {
    if (draft.type === "custom") h.ctx.sessionManager.appendCustomEntry(draft.customType, draft.data);
    else h.ctx.sessionManager.appendContextEdit(draft.targetId, draft.replacement);
  }
  await h.emit("agent_settled", { aborted: false });
  expect(folds.map(event => [event.phase, event.fold])).toEqual([["folded", "fold-1"]]);
  await h.emit("turn_start", {});
  expect(folds).toHaveLength(1);
});

test("a committed fold tells Claude Code bridges to rebuild their conversation", async () => {
  const key = Symbol.for("claude-bridge:markRebuildHooks");
  const calls: Array<[string | null, string]> = [];
  const hooks = new Set([(session: string | null, event: string) => { calls.push([session, event]); }]);
  (globalThis as any)[key] = hooks;
  try {
    const { ids, turn, run, finish, session } = setup();
    let message = turn([call("k1", "compress")]);
    await run("compress", "k1", { from: ids.ask, to: ids.testResult, summary: "Parser fixed." });
    await finish(message, [result("k1", "compress", "ok")], { rejected: true });
    expect(calls).toEqual([]);
    message = turn([call("k2", "compress")]);
    await run("compress", "k2", { from: ids.ask, to: ids.testResult, summary: "Parser fixed." });
    await finish(message, [result("k2", "compress", "ok")]);
    expect(calls).toEqual([[session.getSessionId(), "context-folding:fold-1"]]);
  } finally {
    delete (globalThis as any)[key];
  }
});

test("a failed compress call queues nothing", async () => {
  const { ids, turn, run, finish, visible } = setup();
  const message = turn([call("k1", "compress")]);
  await run("compress", "k1", { from: ids.ask, to: ids.testResult, summary: "summary" });
  const entries = await finish(message, [{ ...result("k1", "compress", "error"), isError: true }]);
  expect(entries).toEqual([]);
  expect(visible()).toHaveLength(9);
});

test("search finds folded originals and reports their state", async () => {
  const { ids, turn, run, finish } = setup();
  const message = turn([call("k1", "compress")]);
  await run("compress", "k1", { from: ids.ask, to: ids.testResult, summary: "Parser fixed." });
  await finish(message, [result("k1", "compress", "ok")]);
  turn([call("q1", "search_context")]);
  const found = (await run("search_context", "q1", { query: "FAIL parser.test.ts" })).content[0].text;
  expect(found).toContain(`- ${ids.testResult} toolResult (folded in fold-1): FAIL parser.test.ts`);
  const visible = (await run("search_context", "q1", { query: "lexer" })).content[0].text;
  expect(visible).toContain(`${ids.next} user (visible)`);
  expect((await run("search_context", "q1", { query: "missing words" })).content[0].text).toContain("No entries match");
});

test("a finished plan step suggests folding its entries", async () => {
  const { turn, finish, session } = setup();
  const plan = (statuses: string[], completed: string[]) => ({ steps: statuses.map((status, index) => ({ id: `s${index}`, goal: `step ${index}`, status })), completed });
  // An earlier update_plan result marks where the finished step began.
  let message = turn([call("p0", "update_plan")]);
  await finish(message, [result("p0", "update_plan", "plan", plan(["in_progress", "pending"], []))]);
  const start = session.appendMessage(assistant([call("c3", "bash", { command: "make" })]) as any);
  const end = session.appendMessage(result("c3", "bash", "z".repeat(20_000)) as any);
  message = turn([call("p1", "update_plan")]);
  const entries = await finish(message, [result("p1", "update_plan", "plan", plan(["completed", "in_progress"], ["s0"]))]);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ type: "custom_message", customType: RECORD_TYPE, display: false });
  expect(entries[0].content).toContain(`Plan step "s0" is complete. Entries ${start}..${end}`);
  expect(entries[0].content).toContain(`compress (from "${start}", to "${end}")`);
  // Online-context-compact owns managed boundaries, avoiding duplicate reminders.
  session.appendMessage(assistant([call("c4", "bash")]) as any);
  session.appendMessage(result("c4", "bash", "w".repeat(40_000)) as any);
  message = turn([call("p2", "update_plan")]);
  expect(await finish(message, [result("p2", "update_plan", "plan", { ...plan(["completed", "completed"], ["s1"]), foldingManaged: true })])).toEqual([]);
});

test("usage reminders fire once per threshold crossing, including during plans", async () => {
  const { h, turn, finish } = setup();
  let percent = 45;
  h.ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 100, percent });
  const step = async () => {
    const message = turn([call(`b${percent}`, "bash")]);
    return finish(message, [result(`b${percent}`, "bash", "ok")]);
  };
  expect((await step())[0].content).toBe("Context is 45% full. Call context_status and fold finished work with compress.");
  percent = 70;
  expect(await step()).toEqual([]);
  percent = 30;
  expect(await step()).toEqual([]);
  percent = 61;
  expect(await step()).toHaveLength(1);
  // A final answer ends the run, so there is no next request to carry a reminder.
  percent = 30;
  await step();
  percent = 90;
  let message = turn([{ type: "text", text: "done" }]);
  expect(await finish(message, [])).toEqual([]);
  // Long unfinished steps still receive usage reminders.
  message = turn([call("p1", "update_plan")]);
  const steps = [{ id: "s0", goal: "step", status: "in_progress" }];
  expect(await finish(message, [result("p1", "update_plan", "plan", { steps, completed: [] })])).toHaveLength(1);
  expect(await step()).toEqual([]);
});
