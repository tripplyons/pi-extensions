import { minimaxEnabled } from "../../lib/minimax.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restore } from "../../lib/common.ts";
import { compactRemote } from "./transport.ts";
import { projectCheckpoint, saveCheckpoint, type SavedCheckpoint } from "./state.ts";
import type { Item } from "./protocol.ts";

import { compactionKey as key, defaultThreshold } from "./settings.ts";

type State = { threshold: number; checkpoint?: SavedCheckpoint; usage?: { model: string; tokens: number } };
export function installCompaction(pi: ExtensionAPI, request = compactRemote) {
  let state: State = { threshold: defaultThreshold };
  let manual = false;
  let pending: AbortController | undefined;
  const cancel = () => { pending?.abort(); pending = undefined; manual = false; };
  const load = (_event: unknown, ctx: ExtensionContext) => {
    cancel(); state = restore<State>(ctx, key) ?? { threshold: defaultThreshold };
  };
  for (const event of ["session_start", "session_switch", "session_fork", "session_tree"] as const) pi.on(event, load);
  pi.on("session_shutdown", cancel);
  pi.on("model_select", cancel);
  pi.registerCommand("threshold", { description: "Show/set Codex and MiniMax compaction token threshold (e.g. 60k)", async handler(args, ctx) {
    const text = args.trim();
    if (text) {
      if (!/^\d+k?$/i.test(text)) throw new Error("Usage: /threshold [positive token count]");
      const value = Number(text.replace(/k$/i, "")) * (/k$/i.test(text) ? 1000 : 1);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Threshold must be a positive integer");
      state.threshold = value; pi.appendEntry(key, state);
    }
    ctx.ui.notify(`Compaction threshold ${state.threshold} tokens`, "info");
  } });
  pi.registerCommand("codex-compact", { description: "Queue opaque Codex compaction for the next request", async handler(args, ctx) {
    if (args.trim()) throw new Error("Usage: /codex-compact");
    if (minimaxEnabled(ctx)) throw new Error("MiniMax mode owns compaction; use /compact");
    if (ctx.model?.provider !== "openai-codex") throw new Error("Select a Codex model first");
    manual = true; ctx.ui.notify("Codex compaction queued for the next request", "info");
  } });
  // Pi's summary compactor cannot preserve opaque Codex checkpoints.
  pi.on("session_before_compact", (_event, ctx) => {
    if (minimaxEnabled(ctx)) { cancel(); return; }
    if (ctx.model?.provider !== "openai-codex") return;
    manual = true;
    ctx.ui.notify("Codex uses opaque compaction on the next request", "info");
    return { cancel: true };
  });
  pi.on("message_end", (event, ctx) => {
    if (minimaxEnabled(ctx)) return;
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== "openai-codex" || message.stopReason === "error" || message.stopReason === "aborted") return;
    state.usage = { model: message.model, tokens: message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite };
    pi.appendEntry(key, state);
  });
  pi.on("before_provider_request", async (event, ctx) => {
    if (minimaxEnabled(ctx)) { cancel(); return; }
    if (ctx.model?.provider !== "openai-codex") return;
    const body = event.payload as Item;
    const input = body.input;
    if (!Array.isArray(input)) return;
    const binding = { session: ctx.sessionManager.getSessionId(), provider: ctx.model.provider, model: String(body.model) };
    const projected = projectCheckpoint(binding, input, state.checkpoint);
    const due = manual || (state.usage?.model === ctx.model.id && state.usage.tokens >= state.threshold);
    if (!due) return { ...body, input: projected };
    if (pending) { ctx.abort(); throw new Error("Codex compaction already pending"); }
    const controller = new AbortController(); pending = controller;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    try {
      const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
      signal.throwIfAborted();
      const replacement = await request({ ...body, input: projected }, binding.session, auth?.auth.apiKey ?? "", signal);
      signal.throwIfAborted();
      state.checkpoint = saveCheckpoint(binding, input, replacement);
      state.usage = undefined; manual = false;
      pi.appendEntry(key, state);
      return { ...body, input: replacement };
    } catch (error) {
      // Pi reports hook errors but otherwise continues with the unmodified payload.
      ctx.abort();
      throw error;
    } finally { if (pending === controller) pending = undefined; }
  });
}
export default function codexCompaction(pi: ExtensionAPI) { installCompaction(pi); }
