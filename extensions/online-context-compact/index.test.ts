import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import { decideCompaction } from "./economics.ts";
import onlineContextCompact, { COMPACTION_INSTRUCTIONS, STATE_KEY } from "./index.ts";

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
  const h = harness();
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
  onlineContextCompact(h.pi);
  const plan = (statuses: string[]) => h.call("update_plan", { steps: statuses.map((status, index) => ({ id: `s${index}`, goal: `step ${index}`, status })) });
  // Project the current branch and count provider requests as Pi would.
  const requests = async (count: number) => {
    const messages = h.entries.filter(entry => entry.type === "message").map(entry => entry.message);
    for (let index = 0; index < count; index++) {
      await h.emit("context", { messages });
      await h.emit("before_provider_request", { payload: {} });
    }
  };
  const finishTurn = async (callId = "test-call") => {
    await h.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ toolCallId: callId, toolName: "update_plan", isError: false }] });
    await h.emit("agent_settled", { aborted: true });
  };
  return { h, compactions, aborted: () => aborted, plan, requests, finishTurn };
}

test("completing a step on a long task compacts and continues", async () => {
  const { h, compactions, aborted, plan, requests, finishTurn } = setup();
  await h.emit("session_start", {});
  await plan(["in_progress", "pending", "pending"]);
  h.entries.push(...conversation());
  await requests(10);
  await plan(["completed", "in_progress", "pending"]);
  await finishTurn();
  expect(aborted()).toBe(1);
  expect(compactions).toHaveLength(1);
  expect(compactions[0].customInstructions).toBe(COMPACTION_INSTRUCTIONS);
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0]!.message).toMatchObject({ customType: STATE_KEY, display: false });
  expect(h.sentMessages[0]!.message.content).toContain("compaction finished");
  expect(h.sentMessages[0]!.options).toEqual({ triggerTurn: true });
});

test("finishing the last step keeps the context", async () => {
  const { h, compactions, aborted, plan, requests, finishTurn } = setup();
  await h.emit("session_start", {});
  await plan(["in_progress"]);
  h.entries.push(...conversation());
  await requests(10);
  await plan(["completed"]);
  await finishTurn();
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

test("a refused compaction still continues the task", async () => {
  const { h, compactions, plan, requests, finishTurn } = setup(new Error("Nothing to compact (session too small)"));
  await h.emit("session_start", {});
  await plan(["in_progress", "pending", "pending"]);
  h.entries.push(...conversation());
  await requests(10);
  await plan(["completed", "in_progress", "pending"]);
  await finishTurn();
  expect(compactions).toHaveLength(1);
  expect(h.sentMessages[0]!.message.content).toContain("compaction was skipped");
});

test("a cancelled compaction does not restart the task", async () => {
  const { h, plan, requests, finishTurn } = setup(new Error("Compaction cancelled"));
  await h.emit("session_start", {});
  await plan(["in_progress", "pending", "pending"]);
  h.entries.push(...conversation());
  await requests(10);
  await plan(["completed", "in_progress", "pending"]);
  await finishTurn();
  expect(h.sentMessages).toHaveLength(0);
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

test("compaction economics", () => {
  expect(decideCompaction(base)).toMatchObject({ compact: true, reason: "economic" });
  expect(decideCompaction({ ...base, requestsPerStep: [1], remainingSteps: 1 })).toMatchObject({ compact: false, reason: "uneconomic" });
  expect(decideCompaction({ ...base, archiveTokens: 500 })).toMatchObject({ compact: false, reason: "no_saving" });
  expect(decideCompaction({ ...base, requestsPerStep: [0], contextWindow: 90_000 })).toMatchObject({ compact: true, reason: "window_protection" });
  expect(decideCompaction({ ...base, priorCompactions: 1, requestsSinceCompaction: 1 })).toMatchObject({ compact: false, reason: "cooldown" });
  // Later compactions also need to repay debt carried from earlier ones.
  expect(decideCompaction({ ...base, priorCompactions: 1, requestsSinceCompaction: 5, carriedDebt: 10_000_000 })).toMatchObject({ compact: false });
});
