import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restore } from "./common.ts";

export const decisionInputLimit = 28_000;
export const jevKey = "rework:jev-policy";
export const jevEnabled = (ctx: ExtensionContext) => restore<{ enabled: boolean }>(ctx, jevKey)?.enabled ?? true;
export type Questions = Record<string, { type: "boolean" | "choice"; instructions: string; criteria?: Record<string, string> }>;
export type Decide = (ctx: ExtensionContext, state: Record<string, unknown>, questions: Questions, signal?: AbortSignal) => Promise<Record<string, unknown>>;

export const decide: Decide = async (ctx, state, questions, cancelled) => {
  if (Buffer.byteLength(JSON.stringify({ state, questions })) > decisionInputLimit) throw new Error("Jev input budget exceeded");
  const signal = AbortSignal.any([AbortSignal.timeout(8000), ...(ctx.signal ? [ctx.signal] : []), ...(cancelled ? [cancelled] : [])]);
  const auth = await ctx.modelRegistry.getProviderAuth("openrouter");
  signal.throwIfAborted();
  if (!auth?.auth.apiKey) throw new Error("Jev needs OpenRouter credentials");
  const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${auth.auth.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "typesafe/jev-1.13", state, questions: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [id, { ...question, type: question.type === "boolean" ? "noul" : "choice" }]),
    ) }),
  });
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
  const body = await response.json() as { answers?: Record<string, { type?: string; noul?: number; choice?: string }> };
  signal.throwIfAborted();
  if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) throw new Error("Invalid Jev answers");
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const answer = body.answers![id];
    if (question.type === "boolean") {
      if (answer?.type !== "noul") throw new Error("Invalid Jev archive answer");
      return [id, { probability: probability({ probability: answer.noul }) }];
    }
    if (answer?.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(question.criteria ?? {}, answer.choice)) throw new Error("Invalid Jev choice");
    return [id, { choice: answer.choice }];
  }));
};

export function probability(answer: unknown): number {
  const value = (answer as { probability?: unknown } | undefined)?.probability;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid Jev probability");
  return value;
}

type HistoryMessage = { role: string; content?: unknown; summary?: string };

// Recover readable summaries from the active branch when absent from context.
export function withSummaries(ctx: ExtensionContext, messages: HistoryMessage[]): HistoryMessage[] {
  const summaries: HistoryMessage[] = [];
  for (const [type, role] of [["compaction", "compactionSummary"], ["branch_summary", "branchSummary"]]) {
    if (messages.some(message => message.role === role && message.summary?.trim())) continue;
    const entry = ctx.sessionManager.getBranch().findLast(entry => entry.type === type);
    if (entry && "summary" in entry && typeof entry.summary === "string") summaries.push({ role, summary: entry.summary });
  }
  return [...summaries, ...messages];
}

// Only ordinary conversation and readable summaries, never reasoning or attachments.
export function recentText(messages: HistoryMessage[], budget = 9000): string[] {
  const excerpts = messages.flatMap(message => {
    const summary = message.role === "compactionSummary" || message.role === "branchSummary";
    if (!summary && message.role !== "user" && message.role !== "assistant") return [];
    const text = summary ? message.summary : typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
    return text?.trim() ? [{ role: message.role, text }] : [];
  });
  const priority = new Set<number>();
  // Reserve room for the latest request and durable context before filling recent history.
  for (const role of ["user", "compactionSummary", "branchSummary", "assistant"]) {
    const index = excerpts.findLastIndex(excerpt => excerpt.role === role);
    if (index >= 0) priority.add(index);
  }
  for (let index = excerpts.length - 1; index >= 0; index--) priority.add(index);
  const selected = new Map<number, string>();
  let used = 2; // JSON array brackets.
  const perMessage = Math.min(4000, Math.floor(budget / 4));
  for (const index of priority) {
    if (selected.size >= 32) break;
    const { role, text } = excerpts[index];
    const available = Math.min(perMessage, budget - used - (selected.size ? 1 : 0));
    const size = (value: string) => Buffer.byteLength(JSON.stringify(value));
    let value = `${role}: ${text}`;
    if (size(value) > available) {
      const points = Array.from(text);
      const excerpt = (count: number) => `${role}: ${points.slice(0, Math.ceil(count / 2)).join("")}\n[...truncated...]\n${count > 1 ? points.slice(-Math.floor(count / 2)).join("") : ""}`;
      let low = 0, high = points.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (size(excerpt(mid)) <= available) low = mid;
        else high = mid - 1;
      }
      if (!low) continue;
      value = excerpt(low);
    }
    used += size(value) + (selected.size ? 1 : 0);
    selected.set(index, value);
  }
  return [...selected].sort(([a], [b]) => a - b).map(([, text]) => text);
}
