import { expect, test } from "bun:test";
import { recentText, withSummaries } from "../../lib/jev.ts";
import { harness } from "../../lib/harness.ts";

test("history includes more conversation without tool-only messages crowding it out", () => {
  const conversation = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}` }));
  const tools = Array.from({ length: 40 }, () => ({ role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "toolCall", arguments: { secret: true } }] }));
  const history = recentText([...conversation, ...tools]);
  expect(history).toHaveLength(20);
  expect(history[0]).toBe("user: message 0");
  expect(history.at(-1)).toBe("assistant: message 19");
  expect(history.join()).not.toContain("secret");
});

test("history prioritizes latest user and summaries, stays byte-bounded, and marks truncation", () => {
  const messages = [
    { role: "compactionSummary", summary: "Important checkpoint " + "😀\n\"".repeat(3000) },
    { role: "branchSummary", summary: "Branch constraints" },
    { role: "user", content: "User constraints " + "界".repeat(10000) + " request ending" },
    ...Array.from({ length: 50 }, (_, i) => ({ role: "assistant", content: `answer ${i}: ` + "x".repeat(10000) })),
    { role: "toolResult", content: "excluded tool output" },
    { role: "system", content: "excluded system prompt" },
  ];
  const history = recentText(messages, 10000);
  expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(10000);
  expect(history.some(text => text.startsWith("user: User constraints") && text.endsWith("request ending"))).toBe(true);
  expect(history.some(text => text.startsWith("compactionSummary: Important checkpoint"))).toBe(true);
  expect(history).toContain("branchSummary: Branch constraints");
  expect(history.some(text => text.startsWith("assistant: answer 49:"))).toBe(true);
  expect(history.join()).toContain("[...truncated...]");
  expect(history.join()).not.toContain("excluded");
  expect(history.join()).not.toContain("\uFFFD");
});

test("readable summaries fall back to the active branch without duplication or opaque data", () => {
  const h = harness();
  h.entries.push({ type: "compaction", summary: "old" }, { type: "compaction", summary: "latest" });
  h.entries.push({ type: "branch_summary", summary: "branch" });
  h.entries.push({ type: "custom", customType: "rework:codex-compaction", data: { checkpoint: { replacement: [{ encrypted_content: "opaque" }] } } });
  expect(recentText(withSummaries(h.ctx, []))).toEqual(["compactionSummary: latest", "branchSummary: branch"]);
  expect(recentText(withSummaries(h.ctx, [{ role: "compactionSummary", summary: "present" }]))).toEqual(["branchSummary: branch", "compactionSummary: present"]);
});

test("history has a 32-message limit and handles empty input", () => {
  expect(recentText([])).toEqual([]);
  expect(recentText(Array.from({ length: 100 }, () => ({ role: "user", content: "hi" })))).toHaveLength(32);
});
