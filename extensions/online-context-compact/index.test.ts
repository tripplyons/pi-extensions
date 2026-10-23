import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import { FOLD_EVENT } from "../context-folding/events.ts";
import contextFolding from "../context-folding/index.ts";
import { CACHE_WRITE_READ_RATIO, decideCompaction } from "./economics.ts";
import onlineContextCompact, { COMPACTION_EVENT, STATE_KEY } from "./index.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// A long conversation: 30 turns of roughly 4,000 tokens each.
function conversation() {
  const entries: any[] = [];
  for (let index = 0; index < 30; index++) {
    const user = { role: "user", content: [{ type: "text", text: `ask ${index} ${"x".repeat(8000)}` }], timestamp: index };
    const assistant = { role: "assistant", content: [{ type: "text", text: `answer ${index} ${"y".repeat(8000)}` }], api: "a", provider: "p", model: "m", usage, stopReason: "stop", timestamp: index };
    for (const message of [user, assistant]) {
      entries.push({ type: "message", id: `e${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: "", message });
    }
  }
  return entries;
}

function setup(compactError?: Error) {
  const h = { ...harness(), boundaries: [] as Function[] };
  const on = h.pi.on;
  h.pi.on = (name: string, handler: Function) => {
    if (name === "turn_end") h.boundaries.push(handler);
    return on(name, handler);
  };
  const compactions: any[] = [];
  let aborted = 0;
  h.ctx.getSystemPrompt = () => "";
  h.ctx.isIdle = () => true;
  h.ctx.abort = () => { aborted++; };
  h.ctx.compact = (options: any) => {
    compactions.push(options);
    if (compactError) options.onError(compactError);
    else options.onComplete({ summary: "summary" });
  };
  const phases: string[] = [];
  h.pi.events.on(COMPACTION_EVENT, ({ phase }: { phase: string }) => phases.push(phase));
  onlineContextCompact(h.pi);
  let planResult: any;
  const plan = async (statuses: string[]) => {
    planResult = await h.call("update_plan", { steps: statuses.map((status, index) => ({ id: `s${index}`, goal: `step ${index}`, status })) });
    return planResult;
  };
  // Project the current branch and count provider requests as Pi would.
  const requests = async (count: number) => {
    const messages = h.entries.filter(entry => entry.type === "message").map(entry => entry.message);
    for (let index = 0; index < count; index++) {
      await h.emit("context", { messages });
      await h.emit("before_provider_request", { payload: {} });
    }
  };
  const finishTurn = async (callId = "test-call") => {
    // Match Pi's boundary protocol: each handler sees earlier handlers' drafts.
    let entries: any[] = [];
    const event = { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ toolCallId: callId, toolName: "update_plan", isError: false, details: planResult?.details }] };
    for (const handler of h.boundaries) {
      const result = await handler({ ...event, entries }, h.ctx);
      if (result?.entries) entries = result.entries;
    }
    await h.emit("agent_settled", { aborted: false });
    return entries;
  };
  return { h, compactions, aborted: () => aborted, phases, plan, requests, finishTurn };
}

test("completing a step requests folding without aborting or native compaction", async () => {
  const { h, compactions, aborted, phases, plan, requests, finishTurn } = setup();
  await h.emit("session_start", {});
  await plan(["in_progress", "pending", "pending"]);
  h.entries.push(...conversation());
  await requests(10);
  await plan(["completed", "in_progress", "pending"]);
  const entries = await finishTurn();
  expect(aborted()).toBe(0);
  expect(compactions).toHaveLength(0);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ type: "custom_message", customType: STATE_KEY, display: false });
  expect(entries[0].content).toContain("use compress");
  expect(h.sentMessages).toHaveLength(0);
  expect(phases).toEqual([]);
  expect(h.entries.findLast(entry => entry.customType === STATE_KEY).data).toMatchObject({ debt: 0, compactions: 0 });
  expect(await finishTurn()).toEqual([]);
});

test("even the last step can request folding of substantial finished work", async () => {
  const { h, compactions, aborted, plan, requests, finishTurn } = setup();
  await h.emit("session_start", {});
  await plan(["in_progress"]);
  h.entries.push(...conversation());
  await requests(10);
  await plan(["completed"]);
  expect(await finishTurn()).toHaveLength(1);
  expect(aborted()).toBe(0);
  expect(compactions).toHaveLength(0);
});

test("only a step that was registered unfinished is a boundary", async () => {
  const { h, compactions, plan, requests, finishTurn } = setup();
  await h.emit("session_start", {});
  h.entries.push(...conversation());
  await requests(10);
  await plan(["completed", "in_progress", "pending"]);
  await finishTurn();
  expect(compactions).toHaveLength(0);
});

test("small sessions do not request folding", async () => {
  const { h, compactions, plan, requests, finishTurn } = setup();
  await h.emit("session_start", {});
  await plan(["in_progress", "pending", "pending"]);
  await requests(10);
  await plan(["completed", "in_progress", "pending"]);
  expect(await finishTurn()).toEqual([]);
  expect(compactions).toHaveLength(0);
});

test("an aborted turn does not request folding or restart the task", async () => {
  const { h, phases, plan, requests, finishTurn } = setup();
  await h.emit("session_start", {});
  await plan(["in_progress", "pending", "pending"]);
  h.entries.push(...conversation());
  await requests(10);
  await plan(["completed", "in_progress", "pending"]);
  h.ctx.signal = AbortSignal.abort();
  expect(await finishTurn()).toEqual([]);
  expect(h.sentMessages).toHaveLength(0);
  expect(phases).toEqual([]);
});

test("the plan survives reload and a correction clears it", async () => {
  const { h, plan } = setup();
  await h.emit("session_start", {});
  await plan(["in_progress", "pending"]);
  const reloaded = setup();
  reloaded.h.entries.push(...h.entries);
  await reloaded.h.emit("session_start", {});
  const result = await reloaded.plan(["completed", "in_progress"]);
  expect(result.details.completed).toEqual(["s0"]);
  await reloaded.h.emit("input", { text: "CORRECTION: use the other API", source: "interactive" });
  expect((await reloaded.plan(["completed", "in_progress"])).details.completed).toEqual([]);
});

test("a context fold adds cache rewrite debt and resets the growth baseline", async () => {
  const { h, requests } = setup();
  await h.emit("session_start", {});
  h.entries.push(...conversation());
  await requests(2);
  const saved = () => h.entries.findLast(entry => entry.customType === STATE_KEY)?.data;
  expect(saved().lastContextTokens).toBeGreaterThan(0);
  h.pi.events.emit(FOLD_EVENT, { phase: "folded", fold: "fold-1", savedTokens: 10_000, rewriteTokens: 40_000, ctx: h.ctx });
  expect(saved()).toMatchObject({ lastContextTokens: null, debt: 40_000 * (CACHE_WRITE_READ_RATIO - 1), repayment: 10_000 });
  // A request repays the saving, and the next one measures growth from a fresh baseline.
  await requests(1);
  expect(saved()).toMatchObject({ debt: 40_000 * (CACHE_WRITE_READ_RATIO - 1) - 10_000, growthCount: 0 });
  h.pi.events.emit(FOLD_EVENT, { phase: "restored", fold: "fold-1", savedTokens: -12_000, rewriteTokens: 50_000, ctx: h.ctx });
  expect(saved().repayment).toBe(0);
});

test("plan updates report advice and reject duplicate IDs", async () => {
  const { h, plan } = setup();
  await h.emit("session_start", {});
  expect((await plan(["in_progress", "in_progress"])).details.advice).toContain("Keep at most one step in_progress.");
  expect((await plan(["pending", "pending"])).details.advice).toContain("Mark one pending step in_progress before starting it.");
  await expect(h.call("update_plan", { steps: [{ id: "a", goal: "x", status: "pending" }, { id: "a", goal: "y", status: "pending" }] }))
    .rejects.toThrow("unique");
});

const base = {
  contextTokens: 80_000, archiveTokens: 60_000, summaryTokens: 1_000, requestsPerStep: [10], remainingSteps: 2,
  averageGrowth: null, contextWindow: null, priorCompactions: 0, requestsSinceCompaction: null, carriedDebt: 0, debtRepayment: 0,
};

test("both extensions preserve other drafts and send one managed boundary request", async () => {
  const { h, plan, requests, finishTurn } = setup();
  const marker = { type: "custom_message", customType: "other", content: "keep", display: false };
  h.boundaries.unshift(() => ({ entries: [marker] }));
  contextFolding(h.pi);
  h.ctx.getContextUsage = () => ({ tokens: 120_000, contextWindow: 200_000, percent: 60 });
  h.entries.push(...conversation());
  await requests(1);
  await plan(["in_progress", "pending"]);
  await plan(["completed", "in_progress"]);
  const entries = await finishTurn();
  expect(entries).toHaveLength(2);
  expect(entries[0]).toEqual(marker);
  expect(entries[1].customType).toBe(STATE_KEY);
});

test("actual rewrite debt gates later requests until window protection is needed", async () => {
  const { h, plan, requests, finishTurn } = setup();
  h.ctx.getContextUsage = () => ({ tokens: 120_000, contextWindow: 200_000, percent: 60 });
  h.entries.push(...conversation());
  await requests(1);
  await plan(["in_progress", "pending"]);
  h.pi.events.emit(FOLD_EVENT, { phase: "restored", fold: "fold-1", savedTokens: 0, rewriteTokens: 120_000, ctx: h.ctx });
  await plan(["completed", "in_progress"]);
  expect(await finishTurn()).toEqual([]);
  h.ctx.getContextUsage = () => ({ tokens: 120_000, contextWindow: 125_000, percent: 96 });
  await plan(["completed", "completed"]);
  expect(await finishTurn()).toHaveLength(1);
});

test("compaction economics", () => {
  expect(decideCompaction(base)).toMatchObject({ compact: true, reason: "economic" });
  expect(decideCompaction({ ...base, requestsPerStep: [1], remainingSteps: 1 })).toMatchObject({ compact: false, reason: "uneconomic" });
  expect(decideCompaction({ ...base, archiveTokens: 500 })).toMatchObject({ compact: false, reason: "no_saving" });
  expect(decideCompaction({ ...base, requestsPerStep: [0], contextWindow: 90_000 })).toMatchObject({ compact: true, reason: "window_protection" });
  expect(decideCompaction({ ...base, priorCompactions: 1, requestsSinceCompaction: 1 })).toMatchObject({ compact: false, reason: "cooldown" });
  // Later compactions also need to repay debt carried from earlier ones.
  expect(decideCompaction({ ...base, priorCompactions: 1, requestsSinceCompaction: 5, carriedDebt: 10_000_000 })).toMatchObject({ compact: false });
});
