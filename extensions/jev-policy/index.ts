import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { jevEnabled, jevKey } from "../../lib/jev.ts";

export function installPolicy(pi: ExtensionAPI) {
  pi.registerCommand("jev", {
    description: "Jev pruning decisions: [on|off]",
    async handler(args, ctx) {
      const value = args.trim();
      if (!["", "on", "off"].includes(value)) throw new Error("Usage: /jev [on|off]");
      if (value) pi.appendEntry(jevKey, { enabled: value === "on" });
      ctx.ui.notify(`Jev ${jevEnabled(ctx) ? "on" : "off"}; pruning requires /pruner on. Uses OpenRouter credentials.`, "info");
    },
  });
}
export default function jevPolicy(pi: ExtensionAPI) { installPolicy(pi); }
