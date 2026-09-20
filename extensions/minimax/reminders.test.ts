import { expect, test } from "bun:test";
import { loopReminder, staleTodos, todoKey, todoReminderKey } from "./reminders.ts";
import { admitsArchive, admitsReminder, footprint } from "./admission.ts";
import { harness } from "../../lib/harness.ts";

function rounds(count: number, polling = false): any[] {
  return Array.from({ length: count }, (_, i) => [
    { role: "assistant", content: [{ type: "toolCall", id: String(i), name: polling ? "task_output" : "grep", arguments: polling ? { task_id: "task", wait_ms: i * 1000 } : { pattern: "[", path: "." } }] },
    { role: "toolResult", toolCallId: String(i), toolName: polling ? "task_output" : "grep", isError: !polling, content: [{ type: "text", text: "same result" }], details: polling ? { task_id: "task", status: "running", output: "", next_offset: 0 } : undefined },
  ]).flat();
}

test("loop warnings require three iterations, ignore call IDs and poll waits, and have a cadence", () => {
  expect(loopReminder(rounds(2))).toBeUndefined();
  expect(loopReminder(rounds(3))?.content).toContain("Change strategy");
  expect(loopReminder(rounds(4))).toBeUndefined(); expect(loopReminder(rounds(6))).toBeDefined();
  expect(loopReminder(rounds(3, true))?.content).toContain("wait for task completion");
  const progress = rounds(3, true); progress.at(-1).details.next_offset = 10;
  expect(loopReminder(progress)).toBeUndefined();
  progress.at(-1).details.next_offset = 0; progress.at(-1).details.status = "succeeded";
  expect(loopReminder(progress)).toBeUndefined();
  const reset = [...rounds(3), { role: "user", content: "try again" }, ...rounds(1)];
  expect(loopReminder(reset)).toBeUndefined();
  const different = rounds(3); different.at(-2).content[0].arguments.pattern = "other";
  expect(loopReminder(different)).toBeUndefined();
  const parallel = rounds(3);
  parallel[0].content = [parallel[0].content[0], parallel[2].content[0], parallel[4].content[0]];
  expect(loopReminder([parallel[0], parallel[1], parallel[3], parallel[5]])).toBeUndefined();
  expect(loopReminder(rounds(61))).toBeUndefined();
  const success = rounds(3); success.at(-1).isError = false;
  expect(loopReminder(success)).toBeUndefined();
});

test("todo cadence follows canonical branch history across compaction and resets on writes", () => {
  const h = harness(); h.pi.appendEntry(todoKey, []);
  const iteration = () => h.entries.push({ type: "message", message: { role: "assistant", stopReason: "toolUse" } });
  for (let i = 0; i < 14; i++) iteration();
  expect(staleTodos(h.ctx)).toBe(false); iteration(); expect(staleTodos(h.ctx)).toBe(true);
  h.entries.push({ type: "compaction", summary: "checkpoint" }); expect(staleTodos(h.ctx)).toBe(true);
  const branch = structuredClone(h.entries);
  h.pi.appendEntry(todoReminderKey, true); expect(staleTodos(h.ctx)).toBe(false);
  h.entries.splice(0, h.entries.length, ...branch); expect(staleTodos(h.ctx)).toBe(true);
  h.pi.appendEntry(todoKey, []); expect(staleTodos(h.ctx)).toBe(false);
  h.pi.appendEntry("rework:minimax", { enabled: false }); for (let i = 0; i < 20; i++) iteration();
  expect(staleTodos(h.ctx)).toBe(true);
});

test("admission uses projected tokens and bytes, includes schemas and selected model limits", () => {
  const h = harness(); h.pi.getActiveTools = () => ["grep"];
  let description = "search";
  h.pi.getAllTools = () => [{ name: "grep", description, parameters: {} }];
  h.ctx.getSystemPrompt = () => "system";
  const messages: any[] = [{ role: "user", content: "short", timestamp: 0 }];
  expect(admitsReminder(messages, h.pi, h.ctx)).toBe(false);
  h.ctx.model = { contextWindow: 2000, maxTokens: 100 };
  expect(admitsReminder(messages, h.pi, h.ctx)).toBe(true);
  description = "x".repeat(10000); expect(admitsReminder(messages, h.pi, h.ctx)).toBe(false);
  h.ctx.model.contextWindow = 200000; expect(admitsReminder(messages, h.pi, h.ctx)).toBe(true);
  expect(admitsArchive([{ ...messages[0], content: "long".repeat(100) }], messages)).toBe(true);
  expect(admitsArchive(messages, messages)).toBe(false);
  expect(admitsArchive(messages, [{ ...messages[0], content: "long".repeat(100) }])).toBe(false);
  const output: any = { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "abc" }], isError: false, timestamp: 0 };
  expect(footprint([output])).toEqual(footprint([{ ...output, details: { data: "x".repeat(10000) } }]));
});
