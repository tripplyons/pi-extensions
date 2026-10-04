import { afterEach, expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import install, { deps, tuning } from "./index.ts";

const original = { ...tuning, summarize: deps.summarize };
afterEach(() => { Object.assign(tuning, { prepareAt: original.prepareAt, refreshTokens: original.refreshTokens, maxGapTokens: original.maxGapTokens }); deps.summarize = original.summarize; });

// Each message is about 1,000 estimated tokens.
function setup() {
  const h = harness(), branch: any[] = [], calls: any[] = [], footer: (string | undefined)[] = [];
  h.ctx.ui.setStatus = (key: string, text?: string) => { if (key === "background-compaction") footer.push(text); };
  let tokens = 12_000;
  Object.assign(tuning, { refreshTokens: 2_000, maxGapTokens: 4_000 });
  h.pi.getSettings = () => ({ compaction: { reserveTokens: 1_000, keepRecentTokens: 3_000 } });
  h.ctx.model = { provider: "test", id: "model" };
  h.ctx.getContextUsage = () => ({ tokens, contextWindow: 20_000, percent: tokens / 200 });
  h.ctx.sessionManager.getBranch = () => branch;
  deps.summarize = (async (messages: any[], _model: any, _reserve: number, _key: any, _headers: any, _signal: any, _instructions: any, previousSummary?: string) => {
    calls.push({ messages, previousSummary });
    return { text: `S${calls.length}`, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } } };
  }) as any;
  const push = (count: number) => {
    for (let i = 0; i < count; i++) {
      const id = `e${branch.length + 1}`, text = `${id} `.padEnd(4_000, "x");
      const message = branch.length % 2 === 0 ? { role: "user", content: text, timestamp: Date.now() }
        : { role: "assistant", content: [{ type: "text", text }], api: "test", provider: "test", model: "model", stopReason: "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      branch.push({ type: "message", id, parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message });
    }
  };
  const compact = async (customInstructions?: string) => (await h.emit("session_before_compact", {
    preparation: { settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 3_000 }, tokensBefore: tokens, firstKeptEntryId: branch.at(-3)?.id,
      fileOps: { read: new Set(["a.ts", "b.ts"]), written: new Set(), edited: new Set(["b.ts"]) } },
    branchEntries: branch, customInstructions, reason: "threshold", willRetry: false, signal: new AbortController().signal,
  }))[0];
  const turn = async () => { await h.emit("turn_end", {}); await new Promise(resolve => setTimeout(resolve, 0)); };
  install(h.pi);
  return { h, branch, calls, footer, push, compact, turn, setTokens: (value: number) => { tokens = value; } };
}

test("a stored summary compacts at the threshold without a new summary call", async () => {
  const { calls, footer, push, compact, turn, setTokens } = setup();
  push(10); setTokens(5_000);
  await turn();
  expect(calls).toHaveLength(0);
  expect(footer.filter(Boolean)).toEqual(["background: waiting"]);
  setTokens(12_000); await turn();
  expect(calls).toHaveLength(1);
  expect(footer.filter(Boolean)).toEqual(["background: waiting", "background: preparing", "background: ready"]);
  expect(calls[0].messages).toHaveLength(7);
  expect(calls[0].previousSummary).toBeUndefined();
  const result = await compact();
  expect(calls).toHaveLength(1);
  expect(result.compaction).toMatchObject({ firstKeptEntryId: "e8", tokensBefore: 12_000, usage: { totalTokens: 15 }, details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] } });
  expect(result.compaction.summary).toBe("S1\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>");
});

test("refreshes summarize only new entries and build on the stored summary", async () => {
  const { calls, push, compact, turn } = setup();
  push(10); await turn();
  push(1); await turn();
  expect(calls).toHaveLength(1);
  push(3); await turn();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ previousSummary: "S1" });
  expect(calls[1].messages.map((message: any) => message.content[0]?.text?.slice(0, 4) ?? message.content.slice(0, 4))).toEqual(["e8 x", "e9 x", "e10 ", "e11 "]);
  const result = await compact();
  expect(result.compaction).toMatchObject({ firstKeptEntryId: "e12", usage: { totalTokens: 30, cost: { total: 6 } } });
  expect(result.compaction.summary.startsWith("S2")).toBe(true);
});

test("Pi summarizes when the stored summary is stale, too far behind, or custom instructions are given", async () => {
  const { h, branch, footer, push, compact, turn, setTokens } = setup();
  push(10); await turn();
  expect(await compact("Focus on tests")).toBeUndefined();
  push(6);
  expect(await compact()).toBeUndefined();
  branch.splice(10);
  expect((await compact())?.compaction.firstKeptEntryId).toBe("e8");
  branch.push({ type: "context_edit", id: "edit", parentId: "e10", timestamp: new Date().toISOString(), targetId: "e2", replacement: { content: [{ type: "text", text: "changed" }] } });
  expect(await compact()).toBeUndefined();
  setTokens(5_000); await turn();
  expect(footer.at(-1)).toBe("background: waiting");
  setTokens(12_000);
  branch.pop(); await turn();
  expect(footer.at(-1)).toBe("background: ready");
  await h.emit("session_compact", {});
  expect(footer.at(-1)).toBe("background: waiting");
  expect(await compact()).toBeUndefined();
});

test("compaction waits for a summary that is still running", async () => {
  const { calls, footer, push, compact, turn } = setup();
  let finish!: () => void;
  const summarize = deps.summarize;
  deps.summarize = (async (...args: any[]) => { await new Promise<void>(resolve => { finish = resolve; }); return (summarize as any)(...args); }) as any;
  push(10); await turn();
  expect(footer.at(-1)).toBe("background: preparing");
  const pending = compact();
  finish();
  expect((await pending).compaction).toMatchObject({ firstKeptEntryId: "e8" });
  expect(calls).toHaveLength(1);
});

function hold() {
  const summarize = deps.summarize, finish: (() => void)[] = [];
  deps.summarize = (async (...args: any[]) => { await new Promise<void>(resolve => finish.push(resolve)); return (summarize as any)(...args); }) as any;
  return () => { for (const resolve of finish.splice(0)) resolve(); };
}

test("a refresh does not delay compaction while the stored summary still fits", async () => {
  const { calls, footer, push, compact, turn } = setup();
  push(10); await turn();
  const finish = hold();
  push(3); await turn();
  expect(footer.at(-1)).toBe("background: ready");
  const result = await compact();
  expect(result.compaction.firstKeptEntryId).toBe("e8");
  expect(result.compaction.summary.startsWith("S1")).toBe(true);
  expect(calls).toHaveLength(1);
  finish();
});

test("compaction waits for a refresh when the stored summary is too far behind", async () => {
  const { footer, push, compact, turn } = setup();
  push(10); await turn();
  const finish = hold();
  push(6); await turn();
  expect(footer.at(-1)).toBe("background: preparing");
  const pending = compact();
  finish();
  const result = await pending;
  expect(result.compaction.firstKeptEntryId).toBe("e14");
  expect(result.compaction.summary.startsWith("S2")).toBe(true);
});

test("waiting is visible on startup and reset, but disabled compaction and shutdown clear it", async () => {
  const { h, footer } = setup();
  await h.emit("session_start");
  expect(footer.at(-1)).toBe("background: waiting");
  await h.emit("model_select");
  expect(footer.at(-1)).toBe("background: waiting");
  await h.emit("session_tree");
  expect(footer.at(-1)).toBe("background: waiting");
  h.pi.getSettings = () => ({ compaction: { enabled: false } });
  await h.emit("turn_end");
  expect(footer.at(-1)).toBeUndefined();
  await h.emit("session_shutdown");
  expect(footer.at(-1)).toBeUndefined();
});
