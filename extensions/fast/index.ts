import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fastExtension(pi: ExtensionAPI) {
  let fast: boolean | undefined;

  pi.events.on("fast:query", (query: { enabled?: boolean }) => { query.enabled = fast === true; });

  pi.on("session_start", (_event, ctx) => {
    fast = undefined;
    ctx.ui.setStatus("fast", undefined);
  });

  pi.registerCommand("fast", {
    description: "Toggle Codex priority requests for this session only",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /fast", "warning");
        return;
      }
      if (ctx.model?.provider !== "openai-codex") {
        ctx.ui.notify("/fast requires an OpenAI Codex model.", "warning");
        return;
      }
      fast = !fast;
      ctx.ui.setStatus("fast", fast ? "fast" : undefined);
      ctx.ui.notify(`Session fast mode ${fast ? "on" : "off"}. Applies to the next request.`, "info");
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
