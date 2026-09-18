import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compactionThreshold } from "../codex-compaction/settings.ts";
import { minimaxEnabled } from "../../lib/minimax.ts";

// Pi's native threshold is model-window based, not /threshold. Stop only at
// request boundaries, then use its manual compactor once the run is idle.
export function installThresholdCompaction(pi: ExtensionAPI) {
  let requested = false;
  let pending = false;
  let generation = 0;
  let failed = false;
  const due = (ctx: ExtensionContext) => minimaxEnabled(ctx) &&
    (ctx.getContextUsage()?.tokens ?? 0) >= compactionThreshold(ctx);
  const reset = () => { generation++; requested = false; failed = false; };
  for (const event of ["session_switch", "session_fork", "session_tree", "session_shutdown"] as const) pi.on(event, reset);
  pi.events.on("rework:minimax-changed", reset);
  pi.on("input", () => { reset(); });
  pi.on("context", (_event, ctx) => {
    if (pending || failed || requested || ctx.signal?.aborted || !due(ctx)) return;
    requested = true;
    ctx.abort();
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (pending || failed || !ctx.isIdle() || !minimaxEnabled(ctx) || (!requested && !due(ctx))) return;
    const resume = requested;
    requested = false;
    pending = true;
    const owner = generation;
    ctx.compact({
      onComplete: () => {
        pending = false;
        if (!resume || owner !== generation || !minimaxEnabled(ctx) || ctx.hasPendingMessages()) return;
        pi.sendMessage({
          customType: "minimax-compaction-resume",
          content: "Context was compacted before the next model request. Continue the interrupted user request from the checkpoint and retained messages. Do not repeat completed tool calls or infer a new goal.",
          display: false,
        }, { triggerTurn: true, deliverAs: "followUp" });
      },
      onError: error => {
        pending = false;
        if (owner !== generation) return;
        failed = true; // No automatic retry loop on a broken summarizer.
        ctx.ui.notify(`MiniMax threshold compaction failed: ${error.message}. Use /compact or send a message to retry.`, "warning");
      },
    });
  });
}
