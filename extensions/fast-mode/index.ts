import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restore } from "../../lib/common.ts";

export function priorityPayload(payload: unknown, provider: string | undefined, enabled: boolean) {
  if (!enabled) return;
  if (provider !== "openai-codex" && provider !== "openai") return;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected an OpenAI request object");
  return { ...payload, service_tier: "priority" };
}
export default function fastMode(pi: ExtensionAPI) {
  let enabled = false;
  const key = "rework:fast";
  const display = (ctx: ExtensionContext) => ctx.ui.setStatus("fast", enabled ? "fast" : undefined);
  const load = (_event: unknown, ctx: ExtensionContext) => { enabled = restore<boolean>(ctx, key) ?? false; display(ctx); };
  for (const event of ["session_start", "session_switch", "session_fork", "session_tree"] as const) pi.on(event, load);
  pi.registerCommand("fast", {
    description: "OpenAI priority service: [on|off] (may incur additional cost)",
    async handler(args, ctx) {
      const value = args.trim();
      if (!["", "on", "off"].includes(value)) throw new Error("Usage: /fast [on|off]");
      const next = value ? value === "on" : !enabled;
      if (next && !["openai", "openai-codex"].includes(ctx.model?.provider ?? "")) throw new Error("Fast mode requires OpenAI or OpenAI Codex");
      enabled = next; pi.appendEntry(key, enabled); display(ctx);
      ctx.ui.notify(`Fast mode ${enabled ? "on (priority service requested)" : "off"}`, "info");
    },
  });
  pi.on("before_provider_request", (event, ctx) => priorityPayload(event.payload, ctx.model?.provider, enabled));
  pi.on("model_select", (_event, ctx) => {
    if (enabled && !["openai", "openai-codex"].includes(ctx.model?.provider ?? "")) {
      enabled = false; pi.appendEntry(key, false); display(ctx);
    }
  });
}
