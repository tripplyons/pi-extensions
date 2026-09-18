import { expect, test } from "bun:test";
import { prune } from "./index.ts";
function messages(count: number, skill = false): any[] {
  return Array.from({ length: count }, (_, i) => [
    { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: skill ? "/skills/SKILL.md" : "file" } }] },
    { role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "x".repeat(12000) }] },
  ]).flat();
}
test("off by default; threshold, keep five, lossless archive, immutable history", () => {
  const state = { enabled: false, serial: 0, archive: {} };
  const source = messages(10);
  expect(prune(source, state, false).changed).toBe(false);
  state.enabled = true;
  const output = prune(source, state, false);
  expect(output.changed).toBe(true); expect(Object.keys(state.archive)).toHaveLength(5);
  expect(output.messages[1].content[0].text).toContain("tp_1");
  expect(source[1].content[0].text.length).toBe(12000);
  expect(output.messages[11].content[0].text.length).toBe(12000);
  expect(prune(source, state, false).messages[1].content[0].text).toContain("tp_1");
});
test("skill reads are protected and manual pruning bypasses threshold", () => {
  const state = { enabled: false, serial: 0, archive: {} };
  expect(prune(messages(10, true), state, true).changed).toBe(false);
  expect(prune(messages(6), state, true).changed).toBe(true);
});
