import { expect, test } from "bun:test";
import install, { prune, installPruner } from "./index.ts";
import { harness } from "../../lib/harness.ts";
function messages(count: number, skill = false): any[] {
  return Array.from({ length: count }, (_, i) => [
    { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: skill ? "/skills/SKILL.md" : "file" } }] },
    { role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "x".repeat(12000) }] },
  ]).flat();
}
test("off by default; threshold, keep five, lossless archive, immutable history", () => {
  const state = { enabled: false, serial: 0, archive: {} };
  const source = messages(14);
  expect(prune(source, state, false).changed).toBe(false);
  state.enabled = true;
  const output = prune(source, state, false);
  expect(output.changed).toBe(true); expect(Object.keys(state.archive)).toHaveLength(9);
  expect(output.messages[1].content[0].text).toContain("tp_1");
  expect(source[1].content[0].text.length).toBe(12000);
  expect(output.messages[19].content[0].text.length).toBe(12000);
  expect(prune(source, state, false).messages[1].content[0].text).toContain("tp_1");
});
test("skill reads are protected and manual pruning bypasses threshold", () => {
  const state = { enabled: false, serial: 0, archive: {} };
  expect(prune(messages(10, true), state, true).changed).toBe(false);
  expect(prune(messages(6), state, true).changed).toBe(true);
});

test("counter resets after pruning and reasoning stays removed on later requests", async () => {
  const h = harness(); install(h.pi);
  h.pi.appendEntry("rework:jev-policy", { enabled: false });
  await h.command("pruner", "on");
  const statuses: unknown[] = [];
  h.ctx.ui.setStatus = (_key: string, value: unknown) => statuses.push(value);
  const source = messages(14);
  source[0].content.unshift({ type: "thinking", thinking: "old reasoning".repeat(1000) });
  const first = (await h.emit("context", { messages: source }))[0];
  expect(statuses.at(-1)).toBe("0.0/50 KB");
  expect(first.messages[0].content.some((b: any) => b.type === "thinking")).toBe(false);
  await h.emit("session_switch");
  const second = (await h.emit("context", { messages: source }))[0];
  expect(statuses.at(-1)).toBe("0.0/50 KB");
  expect(second.messages).toEqual(first.messages);
  expect(source[0].content[0].type).toBe("thinking");
});

test("50 KB threshold retains smaller backlogs", () => {
  const state = { enabled: true, serial: 0, archive: {} };
  const waiting = prune(messages(9), state, false);
  expect(waiting.changed).toBe(false);
  expect(waiting.reclaimable).toBeGreaterThan(40_000);
  expect(waiting.reclaimable).toBeLessThan(50_000);
  expect(prune(messages(10), state, false).reclaimable).toBe(0);
});

test("reasoning-only pruning persists even without old tool results", () => {
  const state = { enabled: true, serial: 0, archive: {} };
  const source = [{ role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(110_000) }] }, ...messages(5)];
  const first = prune(source as any, state, false);
  expect(first.changed).toBe(true);
  expect(first.reclaimable).toBe(0);
  expect(first.messages).toHaveLength(10);
  expect(prune(source as any, state, false).messages).toEqual(first.messages);
});


test("Jev ranks across batches, keeps the best 50 KB plus newest five, and preserves history", async () => {
  const h = harness(); const batches: string[][] = [];
  installPruner(h.pi, async (_ctx, _state, questions) => {
    batches.push(Object.keys(questions));
    return Object.fromEntries(Object.keys(questions).map(id => [id, { probability: Number(id.slice(1)) / 10 }]));
  });
  await h.command("pruner", "on");
  const statuses: unknown[] = [];
  h.ctx.ui.setStatus = (key: string, value: unknown) => { if (key === "pruner") statuses.push(value); };
  const source = messages(14);
  source[0].content.unshift({ type: "thinking", thinking: "retain reasoning" });
  const first = (await h.emit("context", { messages: source }))[0];
  expect(batches).toEqual(Array.from({ length: 9 }, (_, i) => [`c${i}`]));
  for (let i = 0; i < 5; i++) expect(first.messages[i * 2 + 1].content[0].text).toContain("[context-pruner]");
  for (let i = 5; i < 14; i++) expect(first.messages[i * 2 + 1]).toEqual(source[i * 2 + 1]);
  expect(first.messages[0].content[0].type).toBe("thinking");
  expect(Number(String(statuses.at(-1)).split("/")[0])).toBeLessThanOrEqual(50);
  expect((await h.emit("context", { messages: source }))[0].messages).toEqual(first.messages);
  expect(batches).toHaveLength(9);
  expect(source[1].content[0].text.length).toBe(12000);
});

test("missing, invalid, and failed Jev answers retain context", async () => {
  for (const answer of [undefined, { probability: 2 }, { probability: NaN }, new Error("offline")]) {
    const h = harness();
    installPruner(h.pi, async (_ctx, _state, questions) => {
      if (answer instanceof Error) throw answer;
      return Object.fromEntries(Object.keys(questions).map(id => [id, answer]));
    });
    await h.command("pruner", "on");
    const source = messages(14);
    expect((await h.emit("context", { messages: source }))[0].messages).toEqual(source);
  }
});

test("checkpoint-covered interactions are never offered; legacy checkpoints retain all", async () => {
  for (const checkpoint of [{}, { protectedCallIds: ["c0"] }]) {
    const h = harness(); let offered: string[] = [];
    installPruner(h.pi, async (_ctx, _state, questions) => {
      offered = Object.keys(questions);
      return Object.fromEntries(offered.map(id => [id, { probability: 1 }]));
    });
    h.pi.appendEntry("rework:codex-compaction", { checkpoint });
    await h.command("pruner", "on");
    const source = messages(14);
    source[0].content[0].id = "c0|fc_item";
    source[1].toolCallId = "c0|fc_item";
    const output = (await h.emit("context", { messages: source }))[0];
    expect(offered).not.toContain("c0|fc_item");
    expect(output.messages[1]).toEqual(source[1]);
    if (!Object.hasOwn(checkpoint, "protectedCallIds")) expect(offered).toEqual([]);
  }
});

test("session navigation cancels an outstanding pruning decision", async () => {
  const h = harness(); let release!: (value: Record<string, unknown>) => void;
  installPruner(h.pi, () => new Promise(resolve => { release = resolve; }));
  await h.command("pruner", "on");
  const pending = h.emit("context", { messages: messages(14) });
  await h.emit("session_switch");
  release({ c0: { probability: 1 } });
  expect((await pending)[0]).toBeUndefined();
  expect(h.entries.filter(e => e.customType === "rework:pruner")).toHaveLength(1);
});


test("a later batch failure retains the entire pool", async () => {
  const h = harness(); let requests = 0;
  installPruner(h.pi, async (_ctx, _state, questions) => {
    if (++requests === 6) throw new Error("offline");
    return Object.fromEntries(Object.keys(questions).map(id => [id, { probability: 0 }]));
  });
  await h.command("pruner", "on");
  const source = messages(14);
  expect((await h.emit("context", { messages: source }))[0].messages).toEqual(source);
  expect(requests).toBe(6);
});

test("equal importance prefers newer interactions and protections are outside the budget", async () => {
  const h = harness(); const offered: string[] = [];
  installPruner(h.pi, async (_ctx, _state, questions) => {
    offered.push(...Object.keys(questions));
    return Object.fromEntries(Object.keys(questions).map(id => [id, { probability: 0.1 }]));
  });
  await h.command("pruner", "on");
  const source = messages(18);
  source[0].content[0].arguments.path = "/skills/SKILL.md";
  source[3].content.push({ type: "image", data: "image", mimeType: "image/png" });
  source[5].content[0].text = "x".repeat(20000);
  h.pi.appendEntry("rework:codex-compaction", { checkpoint: { protectedCallIds: ["c3"] } });
  const output = (await h.emit("context", { messages: source }))[0].messages;
  for (let i = 0; i < 4; i++) {
    expect(offered).not.toContain(`c${i}`);
    expect(output[i * 2 + 1]).toEqual(source[i * 2 + 1]);
  }
  for (let i = 4; i < 9; i++) expect(output[i * 2 + 1].content[0].text).toContain("[context-pruner]");
  for (let i = 9; i < 18; i++) expect(output[i * 2 + 1]).toEqual(source[i * 2 + 1]);
});

test("manual Jev pruning leaves older interactions that already fit in budget", async () => {
  const h = harness(); let requests = 0;
  installPruner(h.pi, async () => { requests++; return {}; });
  await h.command("prune", "");
  const source = messages(9);
  expect((await h.emit("context", { messages: source }))[0].messages).toEqual(source);
  expect(requests).toBe(0);
});

test("every scoring batch includes conversation and checkpoint history within the input limit", async () => {
  const h = harness(); let batches = 0;
  h.entries.push({ type: "compaction", summary: "Keep the deployment constraints" });
  installPruner(h.pi, async (_ctx, state, questions) => {
    batches++;
    expect(Buffer.byteLength(JSON.stringify({ state, questions }))).toBeLessThanOrEqual(28000);
    const history = state.recent as string[];
    expect(history).toContain("compactionSummary: Keep the deployment constraints");
    expect(history).toContain("user: current request");
    expect(history.filter(text => text.startsWith("assistant:")).length).toBeGreaterThan(6);
    return Object.fromEntries(Object.keys(questions).map(id => [id, { probability: 0.5 }]));
  });
  await h.command("pruner", "on");
  const source = [
    { role: "user", content: "current request" },
    ...Array.from({ length: 20 }, (_, i) => ({ role: "assistant", content: [{ type: "text", text: `Progress ${i} ` + "😀".repeat(40) }] })),
    ...messages(14),
  ];
  await h.emit("context", { messages: source });
  expect(batches).toBe(9);
});

test("automatic Jev pruning waits for 100 KB inclusive, then trims to at most 50 KB", async () => {
  const h = harness(); let requests = 0;
  installPruner(h.pi, async (_ctx, _state, questions) => {
    requests++;
    return Object.fromEntries(Object.keys(questions).map(id => [id, { probability: 0.5 }]));
  });
  await h.command("pruner", "on");
  const source = messages(14);
  const size = () => Array.from({ length: 9 }, (_, i) => Buffer.byteLength(JSON.stringify({
    call: source[i * 2].content[0], output: source[i * 2 + 1].content,
  }))).reduce((a, b) => a + b, 0);
  source[1].content[0].text = "x".repeat(12000 + 99999 - size());
  expect(size()).toBe(99999);
  expect((await h.emit("context", { messages: source }))[0].messages).toEqual(source);
  expect(requests).toBe(0);
  source[1].content[0].text += "x";
  expect(size()).toBe(100000);
  const output = (await h.emit("context", { messages: source }))[0].messages;
  expect(requests).toBeGreaterThan(0);
  let retained = 0;
  for (let i = 0; i < 9; i++) {
    if (output[i * 2 + 1].content[0].text.includes("[context-pruner]")) continue;
    retained += Buffer.byteLength(JSON.stringify({ call: output[i * 2].content[0], output: output[i * 2 + 1].content }));
  }
  expect(retained).toBeLessThanOrEqual(50000);
  for (let i = 9; i < 14; i++) expect(output[i * 2 + 1]).toEqual(source[i * 2 + 1]);
  const after = requests;
  await h.emit("context", { messages: source });
  expect(requests).toBe(after);
});

test("manual Jev pruning bypasses 100 KB trigger but still targets 50 KB", async () => {
  const h = harness(); let requests = 0;
  installPruner(h.pi, async (_ctx, _state, questions) => {
    requests++;
    return Object.fromEntries(Object.keys(questions).map(id => [id, { probability: 0.5 }]));
  });
  await h.command("prune", "");
  const source = messages(11);
  const output = (await h.emit("context", { messages: source }))[0].messages;
  expect(requests).toBeGreaterThan(0);
  expect(output.filter((message: any) => message.role === "toolResult" && message.content[0].text.includes("[context-pruner]"))).toHaveLength(2);
});
