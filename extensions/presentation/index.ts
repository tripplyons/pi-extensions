import { registerCompactToolRenderers } from "./tool-renderers.ts";
import { installCompactToolSpacing } from "./tool-spacing.ts";
import { installCompactUserMessages } from "./user-messages.ts";
import { installHiddenThinkingBlocks } from "./thinking-blocks.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { isCouncilModel } from "../council/index.ts";

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
/** Model family without vendor prefix or versions: claude-opus-5-5 is "opus", gpt-6.1-sol is "sol". */
export function modelFamily(id: string) {
  const words = id.split("/").pop()!.split("-").filter(word => !/\d/.test(word));
  const named = words.length > 1 && ["claude", "gpt"].includes(words[0]) ? words.slice(1) : words;
  return named.length ? named.join("-") : id;
}
export function footerLine(parts: string[], statuses: ReadonlyMap<string, string>, separator: string, width: number) {
  return truncateToWidth([...parts, ...statuses.values()].join(separator), width);
}
export default function presentation(pi: ExtensionAPI) {
  registerCompactToolRenderers(pi);
  let restoreToolSpacing: (() => void) | undefined;
  let restoreUserMessages: (() => void) | undefined;
  let restoreThinkingBlocks: (() => void) | undefined;
  let disposeFooter: (() => void) | undefined;
  let setRunning: ((running: boolean) => void) | undefined;
  let resetBackground: (() => void) | undefined;
  const install = (_event: unknown, ctx: ExtensionContext) => {
    disposeFooter?.();
    if (!ctx.hasUI) return;
    ctx.ui.setToolsExpanded(false);
    if (ctx.mode === "tui") {
      restoreUserMessages ??= installCompactUserMessages();
      restoreThinkingBlocks ??= installHiddenThinkingBlocks();
      restoreToolSpacing ??= installCompactToolSpacing();
    }
    ctx.ui.setWorkingIndicator({ frames: [] });
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setTitle(`pi · ${basename(ctx.cwd)}`);
    ctx.ui.setFooter((tui, theme, data) => {
      const frames = ["[/]", "[-]", "[\\]", "[|]"];
      let frame = 0;
      let running = ctx.isIdle ? !ctx.isIdle() : false;
      const background = new Map<string, boolean>();
      let timer: ReturnType<typeof setInterval> | undefined;
      let disposed = false;
      const active = () => running || [...background.values()].some(Boolean);
      const refresh = () => {
        if (disposed) return;
        if (active() && !timer) {
          frame = 0;
          timer = setInterval(() => {
            frame = (frame + 1) % frames.length;
            tui.requestRender();
          }, 150);
          timer.unref();
        } else if (!active() && timer) {
          clearInterval(timer);
          timer = undefined;
        }
        tui.requestRender();
      };
      const detach = pi.events.on("t3:background-tasks", snapshot => {
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
        const value = snapshot as { sessionFile?: unknown; source?: unknown; tasks?: unknown };
        if (value.sessionFile !== ctx.sessionManager.getSessionFile()
          || typeof value.source !== "string" || !Array.isArray(value.tasks)) return;
        background.set(value.source, value.tasks.length > 0);
        refresh();
      });
      setRunning = value => { running = value; refresh(); };
      resetBackground = () => {
        background.clear();
        refresh();
        pi.events.emit("t3:background-tasks-request", undefined);
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearInterval(timer);
        detach();
        setRunning = undefined;
        resetBackground = undefined;
      };
      disposeFooter = dispose;
      resetBackground();
      return {
        dispose,
        invalidate() {},
        render(width: number) {
          const { cost } = usage(ctx);
          const project = `${active() ? frames[frame] + " " : ""}${basename(ctx.cwd)}`;
          // Effort and fast mode qualify the model instead of taking their own fields.
          const statuses = new Map(data.getExtensionStatuses());
          const settings = [isCouncilModel(ctx.model) ? undefined : pi.getThinkingLevel(), statuses.get("fast")].filter(Boolean);
          statuses.delete("fast");
          const model = ctx.model?.id ? modelFamily(ctx.model.id) : "?";
          const parts = [theme.fg("accent", project), settings.length ? `${model} (${settings.join(", ")})` : model];
          const context = ctx.getContextUsage();
          const window = context?.contextWindow ?? ctx.model?.contextWindow;
          parts.push(`${context?.percent === null || context?.percent === undefined ? "?" : Math.round(context.percent)}%/${window ? tokens(window) : "?"}`);
          parts.push(`$${cost.toFixed(2)}`);
          return [footerLine(parts, statuses, theme.fg("dim", " | "), width)];
        },
      };
    });
  };
  pi.on("session_start", install);
  pi.on("session_tree", () => resetBackground?.());
  pi.on("agent_start", () => setRunning?.(true));
  pi.on("agent_end", () => setRunning?.(false));
  pi.on("session_shutdown", (_event, ctx) => { disposeFooter?.(); disposeFooter = undefined; restoreUserMessages?.(); restoreUserMessages = undefined; restoreThinkingBlocks?.(); restoreThinkingBlocks = undefined; restoreToolSpacing?.(); restoreToolSpacing = undefined; ctx.ui.setFooter(undefined); ctx.ui.setWorkingIndicator(); ctx.ui.setWorkingVisible(true); });
}
