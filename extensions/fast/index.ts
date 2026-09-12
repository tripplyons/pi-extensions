import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FAST_STATE_ENTRY = "fast-state";

export default function fastExtension(pi: ExtensionAPI) {
  let fast: boolean | undefined;

  pi.events.on("fast:query", (query: { enabled?: boolean }) => { query.enabled = fast === true; });

  pi.on("session_start", (_event, ctx) => {
    fast = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== FAST_STATE_ENTRY) continue;
      const data = entry.data;
      if (typeof data !== "object" || data === null || typeof (data as { enabled?: unknown }).enabled !== "boolean") continue;
      fast = (data as { enabled: boolean }).enabled;
    }
    ctx.ui.setStatus("fast", fast ? "fast" : undefined);
  });

  const toggle = async (ctx: ExtensionContext) => {
    if (ctx.model?.provider !== "openai-codex") {
      ctx.ui.notify("/fast requires an OpenAI Codex model.", "warning");
      return;
    }
    fast = !fast;
    pi.appendEntry(FAST_STATE_ENTRY, { enabled: fast });
    ctx.ui.setStatus("fast", fast ? "fast" : undefined);
    ctx.ui.notify(`Session fast mode ${fast ? "on" : "off"}. Applies to the next request.`, "info");
  };

  pi.registerShortcut("ctrl+f", {
    description: "Toggle session fast mode",
    handler: toggle,
  });

  pi.registerCommand("fast", {
    description: "Toggle Codex priority requests for this session only",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /fast", "warning");
        return;
      }
      await toggle(ctx);
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (fast === undefined || ctx.model?.provider !== "openai-codex") return;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      throw new Error("Expected a Codex request object for session fast mode.");
    }
    return { ...event.payload, service_tier: fast ? "priority" : "default" };
  });
}
