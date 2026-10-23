/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Adapted from SoL-Pi Online Context Compact: https://github.com/NVlabs/SoL-Pi
 */
import {
  estimateTokens,
  findCutPoint,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { restore } from "../../lib/common.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";
import { FOLD_EVENT, type FoldEvent } from "../context-folding/events.ts";
import { CACHE_WRITE_READ_RATIO, decideCompaction, type CompactionDecision } from "./economics.ts";

type AgentMessage = Parameters<typeof estimateTokens>[0];

export const STATE_KEY = "online-context-compact";
export const KEEP_RECENT_TOKENS = 20_000;
const SUMMARY_TOKENS = 1_000;
/** Announces planned run stops so loops such as goals do not treat them as failures. */
export const COMPACTION_EVENT = "pi:online-compaction";
export type CompactionPhase = "aborting" | "continuing" | "stopped";
export const COMPACTION_INSTRUCTIONS = "Preserve completed work, verification results, important decisions, and remaining work.";
const CONTINUE_AFTER_COMPACTION = "Online context compaction finished. The task is still active. Continue the remaining work from the current plan. Keep existing step IDs when updating it.";
const CONTINUE_AFTER_SKIP = "Online context compaction was skipped. The existing context is still available. Continue the remaining work from the current plan.";

const stepSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  goal: Type.String({ minLength: 1, maxLength: 2000 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
}, { additionalProperties: false });
const notes = (maxItems: number) => Type.Array(Type.String({ maxLength: 1000 }), { maxItems });
const planSchema = Type.Object({
  steps: Type.Array(stepSchema, { minItems: 1, maxItems: 128 }),
  progress: Type.Optional(Type.Object({
    files_changed: notes(128),
    verification: notes(64),
    decisions: notes(64),
  }, { additionalProperties: false, description: "Evidence for the step just completed" })),
}, { additionalProperties: false });
type Step = Static<typeof stepSchema>;

type State = {
  version: 1;
  plan: Step[];
  requests: number;
  lastStepAt: number;
  requestsPerStep: number[];
  lastCompactionAt: number | null;
  compactions: number;
  lastContextTokens: number | null;
  growthTotal: number;
  growthCount: number;
  // Cache rewrite cost not yet paid back by cheaper requests, in read-token units.
  debt: number;
  repayment: number;
};

const initial = (): State => ({
  version: 1, plan: [], requests: 0, lastStepAt: 0, requestsPerStep: [], lastCompactionAt: null, compactions: 0,
  lastContextTokens: null, growthTotal: 0, growthCount: 0, debt: 0, repayment: 0,
});

// A new task or a correction must not inherit the old plan's request history.
const resetTask = (state: State): State => ({
  ...state, plan: [], lastStepAt: state.requests, requestsPerStep: [], lastContextTokens: null, growthTotal: 0, growthCount: 0,
});

const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
// Other extensions may rewrite tool result content, so match results by call id.
const messageKey = (message: AgentMessage) => message.role === "toolResult" ? `tool:${message.toolCallId}` : JSON.stringify(message);

export function planAdvice(previous: Step[], next: Step[]) {
  const before = new Map(previous.map(step => [step.id, step]));
  // A step added as already completed records history; it is not a finished boundary.
  const completed = next.filter(step => step.status === "completed" && before.has(step.id) && before.get(step.id)!.status !== "completed");
  const advice: string[] = [];
  if (new Set(next.map(step => step.id)).size !== next.length) throw new Error("Plan step IDs must be unique");
  for (const step of next) {
    if (before.has(step.id) && before.get(step.id)!.goal !== step.goal) advice.push(`Step ${JSON.stringify(step.id)} changed goal; reuse an ID only for the same goal.`);
  }
  const active = next.filter(step => step.status === "in_progress").length;
  if (active > 1) advice.push("Keep at most one step in_progress.");
  if (active === 0 && next.some(step => step.status === "pending")) advice.push("Mark one pending step in_progress before starting it.");
  return { completed, advice };
}

// Estimate what Pi's native compaction would summarize, priced as the provider last saw it.
export function archiveTokens(entries: SessionEntry[], keepRecentTokens: number, projected: AgentMessage[]) {
  const seen = new Map<string, number>();
  for (const message of projected) seen.set(messageKey(message), (seen.get(messageKey(message)) ?? 0) + estimateTokens(message));
  const priced = (entry: SessionEntry) => sessionEntryToContextMessages(entry).reduce((total, message) => total + (seen.get(messageKey(message)) ?? 0), 0);
  // The run is aborted before compaction, so price the cut as Pi will see it then.
  const path = [...entries, abortedTurn(entries.at(-1)?.id ?? null)];
  let start = 0;
  let summary = 0;
  const last = path.findLastIndex(entry => entry.type === "compaction");
  if (last >= 0) {
    const compaction = path[last] as Extract<SessionEntry, { type: "compaction" }>;
    const kept = path.findIndex(entry => entry.id === compaction.firstKeptEntryId);
    start = kept >= 0 ? kept : last + 1;
    summary = priced(compaction);
  }
  const end = findCutPoint(path, start, path.length, keepRecentTokens).firstKeptEntryIndex;
  const archived = path.slice(start, end).filter(entry => entry.type !== "compaction");
  if (!archived.some(entry => sessionEntryToContextMessages(entry).length)) return 0;
  return summary + archived.reduce((total, entry) => total + priced(entry), 0);
}

function abortedTurn(parentId: string | null): SessionEntry {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return {
    type: "message", id: "online-context-compact-abort", parentId, timestamp: new Date(0).toISOString(),
    message: { role: "assistant", content: [], api: "none", provider: "none", model: "aborted", usage, stopReason: "aborted", timestamp: 0 },
  } as SessionEntry;
}

export default function onlineContextCompact(pi: ExtensionAPI) {
  let state = initial();
  let restored = false;
  let projected: AgentMessage[] = [];
  let boundaryCallId: string | undefined;
  let selected: CompactionDecision | undefined;
  let pendingDebt: { debt: number; repayment: number } | undefined;
  let compacting = false;
  // After a refused compaction, wait for real tool work before trying again.
  let refused = false;

  const load = (ctx: ExtensionContext) => {
    const saved = restore<State>(ctx, STATE_KEY);
    state = saved?.version === 1 && Array.isArray(saved.plan) ? saved : initial();
    restored = true;
    projected = [];
    boundaryCallId = selected = pendingDebt = undefined;
    compacting = refused = false;
  };
  const ensure = (ctx: ExtensionContext) => { if (!restored) load(ctx); };
  const save = (next: State) => { state = next; pi.appendEntry(STATE_KEY, state); };
  const contextTokens = (ctx: ExtensionContext) => {
    const estimated = projected.reduce((total, message) => total + estimateTokens(message), 0) + tokens(ctx.getSystemPrompt());
    const reported = ctx.getContextUsage()?.tokens;
    return positive(reported) ? Math.max(reported, estimated) : estimated;
  };

  pi.registerTool({
    name: "update_plan",
    label: "Update plan",
    description: "Replace the complete working plan. Completing a registered unfinished step marks a safe point where context may be compacted when that saves cost. Steps added as completed are recorded as history.",
    promptSnippet: "Keep the working plan current",
    promptGuidelines: [
      "Send the complete plan on every update_plan call.",
      "Keep step IDs stable and register unfinished steps before reporting their completion.",
      "Keep at most one step in_progress and mark finished steps completed.",
      "When completing a step, include brief progress evidence when available.",
    ],
    parameters: planSchema,
    executionMode: "sequential",
    async execute(toolCallId, { steps }, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      ensure(ctx);
      const { completed, advice } = planAdvice(state.plan, steps);
      if (completed.length) {
        save({ ...state, plan: steps, lastStepAt: state.requests, requestsPerStep: [...state.requestsPerStep, state.requests - state.lastStepAt] });
        boundaryCallId ??= toolCallId;
      } else {
        save({ ...state, plan: steps });
      }
      const details = { steps, completed: completed.map(step => step.id), advice };
      return { content: [{ type: "text", text: [`Plan: ${JSON.stringify(steps)}`, ...advice].join("\n") }], details };
    },
    renderCall: toolCall("update_plan"),
    renderResult,
  });

  pi.on("session_start", (_event, ctx) => load(ctx));
  pi.on("session_tree", (_event, ctx) => load(ctx));
  pi.on("session_before_tree", () => compacting ? { cancel: true } : undefined);
  pi.on("session_shutdown", () => { boundaryCallId = selected = pendingDebt = undefined; compacting = false; });

  pi.on("context", (event, ctx) => {
    ensure(ctx);
    projected = [...event.messages];
  });

  pi.on("before_provider_request", (_event, ctx) => {
    ensure(ctx);
    const current = contextTokens(ctx);
    const growth = state.lastContextTokens === null ? 0 : current - state.lastContextTokens;
    const debt = Math.max(0, state.debt - state.repayment);
    save({
      ...state,
      requests: state.requests + 1,
      lastContextTokens: current,
      growthTotal: state.growthTotal + Math.max(0, growth),
      growthCount: state.growthCount + (growth > 0 ? 1 : 0),
      debt,
      repayment: debt === 0 ? 0 : state.repayment,
    });
  });

  pi.on("input", (event, ctx) => {
    ensure(ctx);
    refused = false;
    if (event.streamingBehavior === "steer" || event.text.startsWith("CORRECTION:")) {
      boundaryCallId = selected = pendingDebt = undefined;
      save({ ...resetTask(state), debt: 0, repayment: 0 });
    } else if (state.plan.length && state.plan.every(step => step.status === "completed")) {
      save(resetTask(state));
    }
  });

  pi.on("turn_end", (event, ctx) => {
    if (event.toolResults.some(result => result.toolName !== "update_plan" && !result.isError)) refused = false;
    const callId = boundaryCallId;
    boundaryCallId = undefined;
    if (!callId || selected || refused || ctx.signal?.aborted) return;
    const result = event.toolResults.find(item => item.toolCallId === callId);
    const message = event.message;
    if (!result || result.isError || message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return;

    const usage = ctx.getContextUsage();
    const current = contextTokens(ctx);
    const archive = archiveTokens(ctx.sessionManager.getBranch(), KEEP_RECENT_TOKENS, projected);
    if (archive === 0) return;
    const decision = decideCompaction({
      contextTokens: current,
      archiveTokens: archive,
      summaryTokens: SUMMARY_TOKENS,
      requestsPerStep: state.requestsPerStep,
      remainingSteps: state.plan.filter(step => step.status !== "completed").length,
      averageGrowth: state.growthCount ? state.growthTotal / state.growthCount : null,
      contextWindow: positive(usage?.contextWindow) ? usage.contextWindow : positive(ctx.model?.contextWindow) ? ctx.model.contextWindow : null,
      priorCompactions: state.compactions,
      requestsSinceCompaction: state.lastCompactionAt === null ? null : state.requests - state.lastCompactionAt,
      carriedDebt: state.debt,
      debtRepayment: state.repayment,
    });
    if (!decision.compact) return;
    selected = decision;
    pi.events.emit(COMPACTION_EVENT, { phase: "aborting" satisfies CompactionPhase, ctx });
    ctx.abort();
  });

  // Compact between runs, then start a hidden turn so the task continues.
  pi.on("agent_settled", async (_event, ctx) => {
    const decision = selected;
    if (!decision || !ctx.isIdle()) return;
    selected = undefined;
    pendingDebt = { debt: decision.debt, repayment: decision.saving };
    compacting = true;
    const error = await new Promise<Error | undefined>(done => ctx.compact({
      customInstructions: COMPACTION_INSTRUCTIONS,
      onComplete: () => done(undefined),
      onError: done,
    }));
    compacting = false;
    pendingDebt = undefined;
    // Escape during compaction stops the task as well.
    if (error && (error.name === "AbortError" || error.message === "Compaction cancelled")) {
      pi.events.emit(COMPACTION_EVENT, { phase: "stopped" satisfies CompactionPhase, ctx });
      return;
    }
    if (error) {
      refused = true;
      if (ctx.hasUI) ctx.ui.notify(`Online compaction skipped: ${error.message}`, "warning");
    }
    pi.events.emit(COMPACTION_EVENT, { phase: "continuing" satisfies CompactionPhase, ctx });
    pi.sendMessage(
      { customType: STATE_KEY, content: error ? CONTINUE_AFTER_SKIP : CONTINUE_AFTER_COMPACTION, display: false },
      { triggerTurn: true },
    );
  });

  // A fold rewrites the cached prompt from its first entry, like a smaller compaction.
  pi.events.on(FOLD_EVENT, ({ savedTokens, rewriteTokens, ctx }: FoldEvent) => {
    ensure(ctx);
    save({
      ...state,
      lastContextTokens: null,
      debt: state.debt + Math.max(0, rewriteTokens) * (CACHE_WRITE_READ_RATIO - 1),
      repayment: Math.max(0, state.repayment + savedTokens),
    });
  });

  pi.on("session_compact", (event, ctx) => {
    ensure(ctx);
    // Only native summaries from this extension's own compaction carry its priced debt.
    const paid = !event.fromExtension && pendingDebt ? pendingDebt : { debt: 0, repayment: 0 };
    save({
      ...state,
      lastCompactionAt: state.requests,
      compactions: state.compactions + 1,
      // Context sizes are not comparable across the summary.
      lastContextTokens: null,
      debt: state.debt + paid.debt,
      repayment: state.repayment + paid.repayment,
    });
    boundaryCallId = selected = undefined;
    refused = false;
    projected = [];
  });
}
