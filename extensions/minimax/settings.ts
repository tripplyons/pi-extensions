import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restore } from "../../lib/common.ts";

// Keep the persisted key so existing session thresholds survive the migration.
export const compactionKey = "rework:codex-compaction";
export const defaultThreshold = 60_000;

export function compactionThreshold(ctx: ExtensionContext): number {
  return restore<{ threshold: number }>(ctx, compactionKey)?.threshold ?? defaultThreshold;
}

export function registerThreshold(pi: ExtensionAPI) {
  pi.registerCommand("threshold", { description: "Show/set compaction token threshold (e.g. 60k)", async handler(args, ctx) {
    const text = args.trim();
    if (text) {
      if (!/^\d+k?$/i.test(text)) throw new Error("Usage: /threshold [positive token count]");
      const threshold = Number(text.replace(/k$/i, "")) * (/k$/i.test(text) ? 1000 : 1);
      if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error("Threshold must be a positive integer");
      pi.appendEntry(compactionKey, { threshold });
    }
    ctx.ui.notify(`Compaction threshold ${compactionThreshold(ctx)} tokens`, "info");
  } });
}
