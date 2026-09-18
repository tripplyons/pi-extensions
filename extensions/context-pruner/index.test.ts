import { expect, test } from "bun:test";
import install, { prune } from "./index.ts";
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
  await h.command("pruner", "on");
  const statuses: unknown[] = [];
  h.ctx.ui.setStatus = (_key: string, value: unknown) => statuses.push(value);
  const source = messages(14);
  source[0].content.unshift({ type: "thinking", thinking: "old reasoning".repeat(1000) });
  const first = (await h.emit("context", { messages: source }))[0];
  expect(statuses.at(-1)).toBe("0.0/100 KB");
  expect(first.messages[0].content.some((b: any) => b.type === "thinking")).toBe(false);
  await h.emit("session_switch");
  const second = (await h.emit("context", { messages: source }))[0];
  expect(statuses.at(-1)).toBe("0.0/100 KB");
  expect(second.messages).toEqual(first.messages);
  expect(source[0].content[0].type).toBe("thinking");
});

test("100 KB threshold retains smaller backlogs", () => {
  const state = { enabled: true, serial: 0, archive: {} };
  const waiting = prune(messages(10), state, false);
  expect(waiting.changed).toBe(false);
  expect(waiting.reclaimable).toBeGreaterThan(50_000);
  expect(waiting.reclaimable).toBeLessThan(100_000);
  expect(prune(messages(14), state, false).reclaimable).toBe(0);
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
