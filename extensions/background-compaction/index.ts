import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { buildSessionProjection, estimateTokens, generateSummaryWithUsage, type CompactionEntry, type ExtensionAPI, type ExtensionContext, type ProjectedSessionEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";

// prepareAt: share of Pi's compaction threshold where background summaries start.
// refreshTokens: newly summarizable tokens that trigger an incremental refresh.
// maxGapTokens: extra verbatim tokens a stored summary may leave beyond keepRecentTokens.
export const tuning = { prepareAt: 0.75, refreshTokens: 8_000, maxGapTokens: 16_000 };
// Tests replace the summarizer; production uses Pi's own compaction prompt.
export const deps = { summarize: generateSummaryWithUsage };
const defaults = { reserveTokens: 16_384, keepRecentTokens: 20_000 };
const cutRoles = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary"]);

type Span = { entries: ProjectedSessionEntry[]; start: number; previous?: CompactionEntry };
type Cache = { base?: string; ids: string[]; hash: string; summary: string; usage?: Usage };

export function compactionSettings(pi: ExtensionAPI, model?: Pick<Model<any>, "provider" | "id">) {
  const settings = pi.getSettings().compaction ?? {}, override = model ? settings.modelOverrides?.[`${model.provider}/${model.id}`] : undefined;
  return {
    enabled: settings.enabled !== false,
    reserveTokens: override?.reserveTokens ?? settings.reserveTokens ?? defaults.reserveTokens,
    keepRecentTokens: override?.keepRecentTokens ?? settings.keepRecentTokens ?? defaults.keepRecentTokens,
  };
}
function messages(entry: ProjectedSessionEntry): AgentMessage[] {
  return entry.sourceEntry.type === "compaction" ? [] : entry.messages.filter(message => message.role !== "system");
}
function tokens(entries: ProjectedSessionEntry[]) {
  return entries.reduce((sum, entry) => sum + messages(entry).reduce((total, message) => total + estimateTokens(message), 0), 0);
}
// Entries after the newest compaction, as Pi's compaction preparation sees them.
export function span(branch: SessionEntry[]): Span {
  const entries = buildSessionProjection(branch).entries;
  const index = entries.findIndex(entry => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
  return { entries, start: index + 1, previous: index >= 0 ? entries[index].sourceEntry as CompactionEntry : undefined };
}
// Mirrors Pi's projected cut: keep about keepRecentTokens and cut only before a turn or message boundary.
export function cut({ entries, start }: Span, keepRecentTokens: number) {
  let total = 0;
  for (let i = entries.length - 1; i >= start; i--) {
    total += tokens([entries[i]]);
    if (total < keepRecentTokens) continue;
    for (let j = i; j < entries.length; j++) if (messages(entries[j]).some(message => cutRoles.has(message.role))) return j > start ? j : undefined;
    return undefined;
  }
}
function hash({ entries, start }: Span, end: number) {
  return createHash("sha256").update(JSON.stringify(entries.slice(start, end).map(entry => [entry.sourceEntry.id, messages(entry)]))).digest("hex");
}
// Index of the first entry the stored summary does not cover, if it still matches the branch.
export function covers(cache: Cache, current: Span) {
  const end = current.start + cache.ids.length;
  if (cache.base !== current.previous?.id || end >= current.entries.length) return undefined;
  if (current.entries.slice(current.start, end).some((entry, i) => entry.sourceEntry.id !== cache.ids[i])) return undefined;
  return hash(current, end) === cache.hash ? end : undefined;
}
// Index of the first kept entry if the stored summary is current and its cut keeps an acceptable amount of context.
export function fits(cache: Cache, current: Span, keepRecentTokens: number, threshold: number) {
  const end = covers(cache, current);
  if (end === undefined) return undefined;
  const kept = tokens(current.entries.slice(end)), summaryTokens = Math.ceil(cache.summary.length / 4);
  // A stored cut far behind Pi's would leave too much context and compact again soon.
  return kept - keepRecentTokens > tuning.maxGapTokens || kept + summaryTokens >= 0.75 * threshold ? undefined : end;
}
function add(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  return { ...b, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, totalTokens: a.totalTokens + b.totalTokens,
    cost: { input: a.cost.input + b.cost.input, output: a.cost.output + b.cost.output, cacheRead: a.cost.cacheRead + b.cost.cacheRead, cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite, total: a.cost.total + b.cost.total } };
}
function fileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }, previous?: CompactionEntry) {
  const read = new Set(fileOps.read), modified = new Set([...fileOps.edited, ...fileOps.written]);
  // Pi carries file lists only from its own compactions, so carry ours.
  const details = previous?.fromHook ? previous.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined : undefined;
  if (Array.isArray(details?.readFiles)) for (const file of details.readFiles) read.add(String(file));
  if (Array.isArray(details?.modifiedFiles)) for (const file of details.modifiedFiles) modified.add(String(file));
  const modifiedFiles = [...modified].sort(), readFiles = [...read].filter(file => !modified.has(file)).sort();
  const sections = [...(readFiles.length ? [`<read-files>\n${readFiles.join("\n")}\n</read-files>`] : []), ...(modifiedFiles.length ? [`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`] : [])];
  return { readFiles, modifiedFiles, text: sections.length ? `\n\n${sections.join("\n\n")}` : "" };
}

export default function (pi: ExtensionAPI) {
  let cache: Cache | undefined, running: Promise<void> | undefined, controller: AbortController | undefined, epoch = 0, warned = false;
  function usable(ctx: ExtensionContext, current: Span) {
    if (!cache || !ctx.model) return undefined;
    const settings = compactionSettings(pi, ctx.model), usage = ctx.getContextUsage();
    return fits(cache, current, settings.keepRecentTokens, usage ? usage.contextWindow - settings.reserveTokens : Infinity);
  }
  // Ready means compaction would use the stored summary now, even while a refresh runs.
  function show(ctx: ExtensionContext, current = span(ctx.sessionManager.getBranch())) {
    const text = !compactionSettings(pi, ctx.model).enabled ? undefined
      : usable(ctx, current) !== undefined ? "background: ready" : running ? "background: preparing" : "background: waiting";
    try { ctx.ui.setStatus("background-compaction", text); } catch {}
  }
  function reset(ctx: ExtensionContext, shutdown = false) {
    epoch++; cache = undefined; running = undefined; controller?.abort(); controller = undefined;
    if (!shutdown) { show(ctx); return; }
    try { ctx.ui.setStatus("background-compaction", undefined); } catch {}
  }
  function prepare(ctx: ExtensionContext) {
    const current = span(ctx.sessionManager.getBranch());
    // Drop a summary that no longer matches the branch.
    if (cache && covers(cache, current) === undefined) cache = undefined;
    start(ctx, current);
    show(ctx, current);
  }
  function start(ctx: ExtensionContext, current: Span) {
    const model = ctx.model, usage = ctx.getContextUsage();
    if (running || !model || usage?.tokens == null) return;
    const settings = compactionSettings(pi, model);
    if (!settings.enabled || usage.tokens < tuning.prepareAt * (usage.contextWindow - settings.reserveTokens)) return;
    const end = cut(current, settings.keepRecentTokens);
    if (end === undefined) return;
    const prior = cache, covered = prior ? covers(prior, current) : undefined, from = covered ?? current.start;
    const delta = current.entries.slice(from, end);
    if (end <= from || (covered !== undefined && tokens(delta) < tuning.refreshTokens)) return;
    const started = epoch, abort = controller = new AbortController();
    let job: Promise<void> | undefined;
    job = running = (async () => {
      try {
        const result = await deps.summarize(delta.flatMap(messages), model, settings.reserveTokens, undefined, undefined, abort.signal, undefined,
          covered !== undefined ? prior!.summary : current.previous?.summary, pi.getThinkingLevel(), (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options));
        if (started !== epoch || abort.signal.aborted) return;
        cache = { base: current.previous?.id, ids: current.entries.slice(current.start, end).map(entry => entry.sourceEntry.id), hash: hash(current, end), summary: result.text,
          usage: covered !== undefined ? add(prior!.usage, result.usage) : result.usage };
      } catch (error) {
        if (abort.signal.aborted || started !== epoch || warned) return;
        warned = true;
        try { ctx.ui.notify(`Background compaction summary failed; Pi will summarize at the threshold: ${error instanceof Error ? error.message : String(error)}`, "warning"); } catch {}
      } finally {
        if (controller === abort) controller = undefined;
        if (running === job) running = undefined;
        if (started === epoch) show(ctx);
      }
    })();
  }

  pi.on("session_start", (_event, ctx) => { reset(ctx); warned = false; });
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_compact", (_event, ctx) => reset(ctx));
  pi.on("model_select", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => reset(ctx, true));
  pi.on("turn_end", (_event, ctx) => { prepare(ctx); });
  pi.on("session_before_compact", async (event, ctx) => {
    // Custom instructions change the summary, so Pi must write it.
    if (event.customInstructions) return;
    const { preparation } = event, current = span(event.branchEntries), usage = ctx.getContextUsage();
    const threshold = usage ? usage.contextWindow - preparation.settings.reserveTokens : Infinity;
    const check = () => cache && !event.signal.aborted ? fits(cache, current, preparation.settings.keepRecentTokens, threshold) : undefined;
    let end = check();
    // Wait for a running summary only when the stored one cannot be used.
    if (end === undefined && running) {
      await Promise.race([running, new Promise(resolve => event.signal.addEventListener("abort", resolve, { once: true }))]);
      end = check();
    }
    const stored = cache;
    if (end === undefined || !stored) return;
    const files = fileLists(preparation.fileOps, current.previous);
    return { compaction: { summary: stored.summary + files.text, firstKeptEntryId: current.entries[end].sourceEntry.id, tokensBefore: preparation.tokensBefore, usage: stored.usage,
      details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles } } };
  });
}
