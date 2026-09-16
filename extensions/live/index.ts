import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VOICE_MODE_MESSAGE_TYPE = "codex-voice-mode";

type VoiceModeDetails = {
  mode?: unknown;
  state?: unknown;
};

function realtimeState(message: unknown): boolean | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const candidate = message as { customType?: unknown; details?: VoiceModeDetails };
  if (candidate.customType !== VOICE_MODE_MESSAGE_TYPE || candidate.details?.mode !== "realtime") return undefined;
  if (candidate.details.state === "started") return true;
  if (candidate.details.state === "ended") return false;
  return undefined;
}

export default function liveExtension(pi: ExtensionAPI) {
  let realtimeActive = false;

  pi.on("session_start", (_event, ctx) => {
    realtimeActive = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const state = realtimeState(entry.message);
      if (state !== undefined) realtimeActive = state;
    }
  });

  pi.on("message_end", (event) => {
    const state = realtimeState(event.message);
    if (state !== undefined) realtimeActive = state;
  });

  pi.registerCommand("live", {
    description: "Toggle Codex realtime voice",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /live", "warning");
        return;
      }
      pi.sendUserMessage(
        realtimeActive ? "/codex voice stop" : "/codex voice realtime",
        { expandPromptTemplates: true },
      );
    },
  });
}
