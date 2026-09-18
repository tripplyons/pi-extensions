import { compactionThreshold } from "../codex-compaction/settings.ts";
import { installCompactUserMessages } from "./user-messages.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

export function tokens(count: number) {
  if (count < 1000) return count.toFixed(0);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
export function usage(ctx: ExtensionContext) {
  let cost = 0; let last: { input: number; output: number } | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const u = entry.message.usage;
    cost += u.cost.total;
    last = { input: u.input + u.cacheRead + u.cacheWrite, output: u.output };
  }
  return { cost, last };
}
export default function presentation(pi: ExtensionAPI) {
  let restoreUserMessages: (() => void) | undefined;
  const install = (_event: unknown, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setToolsExpanded(false);
    if (ctx.hasUI && ctx.mode === "tui") restoreUserMessages ??= installCompactUserMessages();
    ctx.ui.setWorkingIndicator({ frames: [] });
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setTitle(`pi · ${basename(ctx.cwd)}`);
    ctx.ui.setFooter((_tui, theme, data) => ({
      invalidate() {},
      render(width: number) {
        const { cost, last } = usage(ctx);
        const parts = [theme.fg("accent", basename(ctx.cwd)), ctx.model?.id ?? "?", pi.getThinkingLevel()];
        const threshold = compactionThreshold(ctx);
        parts.push(`${Math.round((last?.input ?? 0) / threshold * 100)}%/${tokens(threshold)}`);
        parts.push(`$${cost.toFixed(2)}`);
        parts.push(...data.getExtensionStatuses().values());
        return [truncateToWidth(parts.join(theme.fg("dim", " | ")), width)];
      },
    }));
  };
  pi.on("session_start", install);
  pi.on("session_switch", install);
  pi.on("session_shutdown", (_event, ctx) => { restoreUserMessages?.(); restoreUserMessages = undefined; ctx.ui.setFooter(undefined); ctx.ui.setWorkingIndicator(); ctx.ui.setWorkingVisible(true); });
}
