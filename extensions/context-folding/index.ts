/*
 * Ideas adapted from billion-context-pi: https://github.com/ranxianglei/billion-context-pi
 * See licenses/billion-context-pi.txt for its MIT license.
 */
import {
  estimateTokens,
  type ContextEditableContent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBoundaryDraft,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";
import { COMPACTION_EVENT } from "../online-context-compact/index.ts";
import { FOLD_EVENT, type FoldEvent } from "./events.ts";

type Message = Parameters<typeof estimateTokens>[0];
type FoldableEntry = Extract<SessionEntry, { type: "message" | "custom_message" }>;
type Item = { entry: FoldableEntry; message: Message; tokens: number };
type FoldRecord = { action: "fold"; fold: string; from: string; to: string; targets: string[]; originalTokens: number; summaryTokens: number };
type UnfoldRecord = { action: "unfold"; fold: string };
type Pending = { drafts: SessionBoundaryDraft[]; event: Omit<FoldEvent, "ctx"> };

export const RECORD_TYPE = "context-folding";
/** Usage that triggers a reminder when no plan is active. */
export const NUDGE_PERCENT = 60;
/** Usage below which the reminder is armed again. */
export const REARM_PERCENT = 50;
/** Smallest finished plan step worth a fold reminder. */
export const MIN_STEP_TOKENS = 8_000;
const PREVIEW_CHARS = 80;
const SNIPPET_CHARS = 300;

const number = (value: number) => Math.round(value).toLocaleString("en-US");
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

function messageText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: any) => {
    if (block.type === "text") return block.text;
    if (block.type === "toolCall") return `${block.name}(${JSON.stringify(block.arguments)})`;
    if (block.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

const originalMessage = (entry: FoldableEntry): Message => entry.type === "message"
  ? entry.message as Message
  : { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: Date.parse(entry.timestamp) } as Message;

const role = (message: Message) => message.role === "custom" ? `custom:${(message as { customType: string }).customType}` : message.role;
const toolCalls = (message: Message): Array<{ id: string; name: string }> =>
  message.role === "assistant" ? message.content.filter(block => block.type === "toolCall") : [];
const incomplete = (message: Message) => message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");

// Model-visible entries that a context edit can replace, in context order.
function visibleItems(ctx: ExtensionContext) {
  const projection = ctx.sessionManager.buildSessionProjection();
  const items: Item[] = [];
  for (const { sourceEntry, messages } of projection.entries) {
    if ((sourceEntry.type !== "message" && sourceEntry.type !== "custom_message") || messages.length !== 1) continue;
    items.push({ entry: sourceEntry, message: messages[0]!, tokens: estimateTokens(messages[0]!) });
  }
  const total = projection.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  // The latest assistant message is the current turn; its tool results are still in use.
  const current = items.findLastIndex(item => item.message.role === "assistant");
  return { items, foldable: current < 0 ? [] : items.slice(0, current), total };
}

type Fold = FoldRecord & { index: number; state: "active" | "restored" | "compacted" | { inside: string } };

// Rebuild fold state from the active branch so /tree, forks, and reloads need no other storage.
function scanFolds(ctx: ExtensionContext, visible: Set<string>) {
  const branch = ctx.sessionManager.getBranch();
  const folds = new Map<string, Fold>();
  // Every context edit per target, and the folds currently covering it, innermost first.
  const edits = new Map<string, Array<{ index: number; replacement: { content: ContextEditableContent } | null }>>();
  const stacks = new Map<string, string[]>();
  // Edits belong to a record only when they directly follow it, as one boundary commits them.
  let owner: { record: FoldRecord | UnfoldRecord; targets: Set<string> } | undefined;
  branch.forEach((entry, index) => {
    if (entry.type === "custom" && entry.customType === RECORD_TYPE) {
      const record = entry.data as FoldRecord | UnfoldRecord;
      if (record.action === "fold") folds.set(record.fold, { ...record, index, state: "active" });
      else if (folds.has(record.fold)) folds.get(record.fold)!.state = "restored";
      owner = { record, targets: new Set(folds.get(record.fold)?.targets) };
      return;
    }
    if (entry.type !== "context_edit") { owner = undefined; return; }
    edits.set(entry.targetId, [...edits.get(entry.targetId) ?? [], { index, replacement: entry.replacement }]);
    if (!owner?.targets.has(entry.targetId)) return;
    const stack = (stacks.get(entry.targetId) ?? []).filter(id => id !== owner!.record.fold);
    stacks.set(entry.targetId, owner.record.action === "fold" ? [...stack, owner.record.fold] : stack);
  });
  const owners = new Map([...stacks].map(([target, stack]) => [target, stack.at(-1)]));
  for (const fold of folds.values()) {
    if (fold.state === "restored") continue;
    const outer = fold.targets.map(target => owners.get(target)).find(id => id && id !== fold.fold);
    if (outer) fold.state = { inside: outer };
    else if (!fold.targets.some(target => visible.has(target))) fold.state = "compacted";
  }
  // The content a target showed before a fold, or undefined for its original content.
  const prior = (fold: Fold, target: string) => edits.get(target)?.filter(edit => edit.index < fold.index).at(-1)?.replacement?.content;
  return { folds, prior, owners, branch };
}

// A fold must keep every tool call next to its result, or the provider rejects the request.
export function checkRange(items: Item[], start: number, end: number): string | undefined {
  const range = items.slice(start, end + 1);
  const outside = [...items.slice(0, start), ...items.slice(end + 1)];
  const calls = new Set(range.flatMap(item => toolCalls(item.message).map(call => call.id)));
  for (const item of range) {
    if (item.message.role === "toolResult" && !calls.has(item.message.toolCallId)) {
      return `Entry ${item.entry.id} is a tool result whose call is outside the range; start the range at that call's assistant entry.`;
    }
  }
  for (const item of outside) {
    if (item.message.role === "toolResult" && calls.has(item.message.toolCallId)) {
      return `Tool result ${item.entry.id} answers a call inside the range; end the range at or after it.`;
    }
  }
  if (incomplete(range.at(-1)!.message)) return `Entry ${range.at(-1)!.entry.id} is an interrupted assistant turn; end the range at a completed entry.`;
}

// The last entry carries the summary; a tool result also keeps the single call it answers.
function foldDrafts(range: Item[], header: string, summary: string) {
  const last = range.at(-1)!;
  const text = [{ type: "text" as const, text: `${header}\n${summary}` }];
  const replacements = new Map<string, { content: ContextEditableContent } | null>(range.map(item => [item.entry.id, null]));
  replacements.set(last.entry.id, { content: text });
  if (last.message.role === "toolResult") {
    const callId = last.message.toolCallId;
    const owner = range.find(item => toolCalls(item.message).some(call => call.id === callId))!;
    const call = (owner.message as Extract<Message, { role: "assistant" }>).content.find(block => block.type === "toolCall" && block.id === callId)!;
    replacements.set(owner.entry.id, { content: [call] });
  }
  const drafts: SessionBoundaryDraft[] = [...replacements].map(([targetId, replacement]) => ({ type: "context_edit", targetId, replacement }));
  const summaryTokens = [...replacements].reduce((sum, [id, replacement]) => {
    if (!replacement) return sum;
    const message = range.find(item => item.entry.id === id)!.message;
    return sum + estimateTokens({ ...message, content: replacement.content } as Message);
  }, 0);
  return { drafts, summaryTokens };
}

// Group each assistant entry with its tool results so listed ranges are valid fold units.
function outline(foldable: Item[], owners: Map<string, string | undefined>) {
  const lines: string[] = [];
  for (let index = 0; index < foldable.length;) {
    const item = foldable[index]!;
    const calls = new Set(toolCalls(item.message).map(call => call.id));
    let end = index;
    while (calls.size && foldable[end + 1]?.message.role === "toolResult" && calls.has((foldable[end + 1]!.message as { toolCallId: string }).toolCallId)) end++;
    const unit = foldable.slice(index, end + 1);
    const tokens = unit.reduce((sum, part) => sum + part.tokens, 0);
    const ref = end > index ? `${item.entry.id}..${foldable[end]!.entry.id}` : item.entry.id;
    const results = end > index ? ` + ${end - index} results` : "";
    const names = toolCalls(item.message).map(call => call.name);
    const preview = oneLine(messageText({ ...item.message, content: item.message.role === "assistant" ? item.message.content.filter(block => block.type === "text") : (item.message as any).content } as Message), PREVIEW_CHARS);
    const fold = unit.map(part => owners.get(part.entry.id)).find(Boolean);
    lines.push(`- ${ref} ${role(item.message)}${results} ~${number(tokens)}${names.length ? ` [${names.join(", ")}]` : ""}${preview ? `: ${preview}` : ""}${fold ? ` (${fold})` : ""}`);
    index = end + 1;
  }
  return lines;
}

export default function contextFolding(pi: ExtensionAPI) {
  const pending = new Map<string, Pending>();
  let armed = true;
  let compacting = false;
  let plan: Array<{ status: string }> = [];

  const pendingTargets = () => new Set([...pending.values()].flatMap(item => item.drafts.flatMap(draft => draft.type === "context_edit" ? [draft.targetId] : [])));
  const foldCount = (ctx: ExtensionContext) => ctx.sessionManager.getBranch()
    .filter(entry => entry.type === "custom" && entry.customType === RECORD_TYPE && (entry.data as FoldRecord).action === "fold").length;
  const reset = () => { pending.clear(); armed = true; compacting = false; plan = []; };
  const loadPlan = (ctx: ExtensionContext) => {
    reset();
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "update_plan" && !entry.message.isError) {
        plan = (entry.message.details as { steps?: typeof plan } | undefined)?.steps ?? [];
        return;
      }
    }
  };

  pi.on("session_start", (_event, ctx) => loadPlan(ctx));
  pi.on("session_tree", (_event, ctx) => loadPlan(ctx));
  pi.on("session_compact", () => { pending.clear(); armed = true; });
  pi.events.on(COMPACTION_EVENT, (event: { phase: string }) => { if (event.phase === "aborting") compacting = true; });

  pi.registerTool({
    name: "context_status",
    label: "Context status",
    description: "Show context usage, active folds, and foldable entries with the refs that compress accepts. Each line is one user message, or one assistant turn with its tool results, so its ref range is a valid fold unit.",
    promptSnippet: "Show context usage and foldable entry refs",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { items, foldable, total } = visibleItems(ctx);
      const { folds, owners } = scanFolds(ctx, new Set(items.map(item => item.entry.id)));
      const usage = ctx.getContextUsage();
      const window = usage?.contextWindow ?? ctx.model?.contextWindow;
      const used = usage?.tokens ?? total;
      const active = [...folds.values()].filter(fold => fold.state !== "restored" && fold.state !== "compacted");
      const lines = [
        `Context: ~${number(used)}${window ? ` of ${number(window)} tokens (${Math.round(used / window * 100)}%)` : " tokens"}.`,
        active.length ? "Folds:" : "Folds: none.",
        ...active.map(fold => `- ${fold.fold}: ${fold.from}..${fold.to}, ${fold.targets.length} entries, ~${number(fold.originalTokens)} -> ~${number(fold.summaryTokens)} tokens${typeof fold.state === "object" ? `, inside ${fold.state.inside}` : ""}`),
        foldable.length ? "Foldable entries (ref, role, ~tokens):" : "Foldable entries: none.",
        ...outline(foldable, owners),
      ];
      const details = { tokens: used, contextWindow: window ?? null, folds: active.map(({ index: _index, ...fold }) => fold), foldable: foldable.length };
      return { content: [{ type: "text", text: lines.join("\n") }], details };
    },
    renderCall: toolCall("context_status"),
    renderResult,
  });

  pi.registerTool({
    name: "compress",
    label: "Compress",
    description: "Fold a contiguous range of earlier entries into your own summary. The last entry carries the summary and the rest leave model context; the session keeps the originals, and decompress restores them. The fold applies after the current turn's tool calls finish.",
    promptSnippet: "Fold finished context into a summary",
    promptGuidelines: [
      "When earlier work is finished and you no longer need it verbatim, call context_status for refs, then fold that range with compress.",
      "In compress summaries, keep file paths, function names, decisions, exact error messages, verification results, and open issues. Drop logs, duplicates, and exploration that led nowhere.",
      "Do not fold the working set you still need to quote or edit. Use search_context or decompress to recover folded details.",
    ],
    parameters: Type.Object({
      from: Type.String({ description: "Ref of the first entry, from context_status" }),
      to: Type.String({ description: "Ref of the last entry, from context_status; may equal from" }),
      summary: Type.String({ minLength: 1, description: "Self-contained summary that replaces the range" }),
    }),
    executionMode: "sequential",
    async execute(toolCallId, { from, to, summary }, _signal, _onUpdate, ctx) {
      const { items, foldable } = visibleItems(ctx);
      const start = foldable.findIndex(item => item.entry.id === from);
      const end = foldable.findIndex(item => item.entry.id === to);
      if (start < 0 || end < 0) {
        const missing = start < 0 ? from : to;
        throw new Error(`Ref ${missing} is not a foldable entry. Use a ref from context_status; the current turn cannot be folded.`);
      }
      if (start > end) throw new Error(`Ref ${from} comes after ${to}.`);
      const error = checkRange(items, items.indexOf(foldable[start]!), items.indexOf(foldable[end]!));
      if (error) throw new Error(error);
      const range = foldable.slice(start, end + 1);
      const queued = pendingTargets();
      if (range.some(item => queued.has(item.entry.id))) throw new Error("The range overlaps a fold queued in this turn.");
      const fold = `fold-${foldCount(ctx) + pending.size + 1}`;
      const originalTokens = range.reduce((sum, item) => sum + item.tokens, 0);
      const { drafts, summaryTokens } = foldDrafts(range, `[${fold}: ${range.length} entries folded; decompress restores them]`, summary.trim());
      if (summaryTokens >= originalTokens) throw new Error(`The summary (~${number(summaryTokens)} tokens) is not shorter than the range (~${number(originalTokens)} tokens).`);
      const record: FoldRecord = { action: "fold", fold, from, to, targets: range.map(item => item.entry.id), originalTokens, summaryTokens };
      const after = items.slice(items.indexOf(range[0]!)).reduce((sum, item) => sum + item.tokens, 0);
      const savedTokens = originalTokens - summaryTokens;
      pending.set(toolCallId, {
        drafts: [{ type: "custom", customType: RECORD_TYPE, data: record }, ...drafts],
        event: { phase: "folded", fold, savedTokens, rewriteTokens: after - savedTokens },
      });
      const text = `${fold} folds ${range.length} entries (~${number(originalTokens)} -> ~${number(summaryTokens)} tokens) after this turn's tool calls finish.`;
      return { content: [{ type: "text", text }], details: { ...record, savedTokens } };
    },
    renderCall: toolCall("compress"),
    renderResult,
  });

  pi.registerTool({
    name: "decompress",
    label: "Decompress",
    description: "Restore the entries of an active fold to model context. Restore an enclosing fold first. Applies after the current turn's tool calls finish.",
    promptSnippet: "Restore a folded range",
    parameters: Type.Object({ fold: Type.String({ description: "Fold ID, such as fold-1" }) }),
    executionMode: "sequential",
    async execute(toolCallId, { fold: id }, _signal, _onUpdate, ctx) {
      const { items } = visibleItems(ctx);
      const { folds, prior, branch } = scanFolds(ctx, new Set(items.map(item => item.entry.id)));
      const fold = folds.get(id);
      if (!fold) throw new Error(`Fold ${id} does not exist on this branch.`);
      if (fold.state === "restored") throw new Error(`Fold ${id} is already restored.`);
      if (fold.state === "compacted") throw new Error(`Fold ${id} was removed by compaction; search_context can still find its entries.`);
      if (typeof fold.state === "object") throw new Error(`Fold ${id} is inside ${fold.state.inside}; decompress ${fold.state.inside} first.`);
      if ([...pending.values()].some(item => item.event.fold === id)) throw new Error(`Fold ${id} is already queued in this turn.`);
      const byId = new Map(branch.map(entry => [entry.id, entry]));
      const drafts: SessionBoundaryDraft[] = [];
      let restoredTokens = 0;
      for (const target of fold.targets) {
        const entry = byId.get(target) as FoldableEntry;
        const original = originalMessage(entry);
        const content = prior(fold, target) ?? (original as { content: ContextEditableContent }).content;
        restoredTokens += estimateTokens({ ...original, content } as Message);
        drafts.push({ type: "context_edit", targetId: target, replacement: { content } });
      }
      const first = items.findIndex(item => fold.targets.includes(item.entry.id));
      const after = items.slice(first).reduce((sum, item) => sum + item.tokens, 0);
      const savedTokens = fold.summaryTokens - restoredTokens;
      const record: UnfoldRecord = { action: "unfold", fold: id };
      pending.set(toolCallId, {
        drafts: [{ type: "custom", customType: RECORD_TYPE, data: record }, ...drafts],
        event: { phase: "restored", fold: id, savedTokens, rewriteTokens: after - savedTokens },
      });
      const text = `${id} restores ${fold.targets.length} entries (~${number(restoredTokens)} tokens) after this turn's tool calls finish.`;
      return { content: [{ type: "text", text }], details: { fold: id, entries: fold.targets.length, restoredTokens } };
    },
    renderCall: toolCall("decompress"),
    renderResult,
  });

  pi.registerTool({
    name: "search_context",
    label: "Search context",
    description: "Search this branch's original messages, including folded and compacted ones. All case-insensitive literal terms must match one entry. Returns refs, context state, and snippets.",
    promptSnippet: "Search original messages, including folded ones",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Default 10" })),
    }),
    async execute(_toolCallId, { query, limit = 10 }, _signal, _onUpdate, ctx) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const { items } = visibleItems(ctx);
      const visible = new Set(items.map(item => item.entry.id));
      const { owners, branch } = scanFolds(ctx, visible);
      const matches: string[] = [];
      for (const entry of [...branch].reverse()) {
        if (entry.type !== "message" && entry.type !== "custom_message") continue;
        const message = originalMessage(entry);
        const text = messageText(message);
        const lower = text.toLowerCase();
        if (!terms.every(term => lower.includes(term))) continue;
        const at = lower.indexOf(terms[0]!);
        const begin = Math.max(0, at - SNIPPET_CHARS / 2);
        const snippet = oneLine(text.slice(begin, begin + SNIPPET_CHARS), SNIPPET_CHARS);
        const state = owners.get(entry.id) ? `folded in ${owners.get(entry.id)}` : visible.has(entry.id) ? "visible" : "not in context";
        matches.push(`- ${entry.id} ${role(message)} (${state}): ${begin > 0 ? "..." : ""}${snippet}`);
        if (matches.length >= limit) break;
      }
      const text = matches.length ? matches.join("\n") : `No entries match ${JSON.stringify(query)}.`;
      return { content: [{ type: "text", text }], details: { matches: matches.length } };
    },
    renderCall: toolCall("search_context"),
    renderResult,
  });

  // Apply queued folds at the turn boundary, after their tool results are saved.
  pi.on("turn_end", (event, ctx) => {
    const entries = [...(event.entries ?? [])];
    let folded = false;
    for (const result of event.toolResults) {
      const queued = pending.get(result.toolCallId);
      if (!queued || result.isError) continue;
      entries.push(...queued.drafts);
      pi.events.emit(FOLD_EVENT, { ...queued.event, ctx } satisfies FoldEvent);
      folded = true;
    }
    pending.clear();
    const skip = folded || compacting;
    compacting = false;
    const message = event.message;
    if (skip || message.role !== "assistant" || message.stopReason !== "toolUse" || ctx.signal?.aborted) return folded ? { entries } : undefined;
    const reminder = stepReminder(event.toolResults, ctx) ?? usageReminder(ctx);
    if (!reminder) return;
    return { entries: [...entries, { type: "custom_message", customType: RECORD_TYPE, content: reminder, display: false }] };
  });

  // Suggest folding a finished plan step's entries, from the previous step boundary to this turn.
  function stepReminder(results: Array<{ toolName: string; isError: boolean; details?: unknown }>, ctx: ExtensionContext) {
    const update = results.findLast(result => result.toolName === "update_plan" && !result.isError);
    if (!update) return;
    const details = update.details as { steps?: typeof plan; completed?: string[] } | undefined;
    plan = details?.steps ?? plan;
    if (!details?.completed?.length) return;
    const { items, foldable } = visibleItems(ctx);
    const boundary = foldable.findLastIndex(item => item.message.role === "toolResult" && item.message.toolName === "update_plan");
    let start = boundary + 1;
    while (foldable[start]?.message.role === "toolResult") start++;
    const range = foldable.slice(start);
    if (!range.length || checkRange(items, items.indexOf(range[0]!), items.indexOf(range.at(-1)!))) return;
    const tokens = range.reduce((sum, item) => sum + item.tokens, 0);
    if (tokens < MIN_STEP_TOKENS) return;
    const steps = details.completed.map(id => JSON.stringify(id)).join(", ");
    return `Plan step ${steps} is complete. Entries ${range[0]!.entry.id}..${range.at(-1)!.entry.id} (~${number(tokens)} tokens) cover its work. If you no longer need them verbatim, fold them with compress (from "${range[0]!.entry.id}", to "${range.at(-1)!.entry.id}").`;
  }

  // Without an active plan, remind once each time usage crosses the threshold.
  function usageReminder(ctx: ExtensionContext) {
    const percent = ctx.getContextUsage()?.percent;
    if (typeof percent !== "number") return;
    if (percent < REARM_PERCENT) armed = true;
    if (!armed || percent < NUDGE_PERCENT || plan.some(step => step.status !== "completed")) return;
    armed = false;
    return `Context is ${Math.round(percent)}% full. Call context_status and fold finished work with compress.`;
  }
}
