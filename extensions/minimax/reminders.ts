import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const todoKey = "rework:minimax-todos";
export const todoReminderKey = "rework:minimax-todo-reminder";
export const loopReminderKey = "rework:minimax-loop-reminder";
export const todoReminder = "MiniMax task reminder: unfinished todos have not been updated for 15 assistant iterations. Review the stored list and use todo_write if its status has changed. Do not invent completion, create a goal, or continue solely because of this reminder.";

export function staleTodos(ctx: ExtensionContext) {
  let iterations = 0;
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type === "custom" && (entry.customType === todoKey || entry.customType === todoReminderKey)) return iterations >= 15;
    if (entry.type === "message" && entry.message.role === "assistant" && !["error", "aborted"].includes(entry.message.stopReason)) iterations++;
  }
  return false;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// Only the current user turn, and only repeated outcomes across distinct
// assistant iterations. Parallel duplicate calls do not count as a loop.
export function loopReminder(messages: AgentMessage[]) {
  const recent: Map<string, string>[] = [];
  let round = new Map<string, string>();
  let calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  for (const message of messages) {
    if (message.role === "user") { recent.length = 0; round = new Map(); calls.clear(); }
    if (message.role === "assistant") {
      round = new Map(); recent.push(round);
      calls = new Map(message.content.filter(block => block.type === "toolCall").map(call => [call.id, call]));
    }
    if (message.role !== "toolResult") continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    let signature: string | undefined;
    if (message.isError) signature = stable([call.name, call.arguments, message.content]);
    else if (call.name === "task_output") {
      const output = message.details as { task_id?: string; status?: string; output?: string; next_offset?: number } | undefined;
      if (output && ["running", "queued", "stopping"].includes(output.status ?? "") && typeof output.next_offset === "number") {
        signature = stable([call.name, output.task_id, output.status, output.next_offset]);
      }
    }
    if (signature) round.set(signature, message.toolCallId);
  }
  if (recent.length < 3) return;
  for (const [signature, callId] of round) {
    let repeats = 0;
    for (const iteration of [...recent].reverse()) {
      if (!iteration.has(signature)) break;
      repeats++;
    }
    if (repeats < 3 || repeats % 3 !== 0) continue;
    return {
      id: createHash("sha256").update(signature + callId).digest("hex"),
      content: "MiniMax loop reminder: three assistant iterations repeated the same failure or polled a task without advancing its output. Change strategy, inspect the cause, or wait for task completion instead of repeating the call. A task ID already represents a running command; do not restart it. This is not evidence that the task is complete or blocked.",
    };
  }
}
