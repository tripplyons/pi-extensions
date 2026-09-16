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
  let mutedByFocus = false;
  let stopInput: (() => void) | undefined;

  const dispatch = (command: string) => {
    pi.sendUserMessage(command, { expandPromptTemplates: true });
  };

  pi.on("session_start", (_event, ctx) => {
    realtimeActive = false;
    mutedByFocus = false;
    stopInput?.();
    stopInput = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const state = realtimeState(entry.message);
      if (state !== undefined) realtimeActive = state;
    }
    if (ctx.mode === "tui" && process.env.OVERSEER === "1") {
      stopInput = ctx.ui.onTerminalInput((data) => {
        if (data === "\x1b[O" && realtimeActive && !mutedByFocus) {
          mutedByFocus = true;
          try {
            dispatch("/codex voice mute");
          } catch (error) {
            mutedByFocus = false;
            throw error;
          }
        } else if (data === "\x1b[I" && mutedByFocus) {
          mutedByFocus = false;
          try {
            dispatch("/codex voice mute");
          } catch (error) {
            mutedByFocus = true;
            throw error;
          }
        }
      });
    }
  });

  pi.on("message_end", (event) => {
    const state = realtimeState(event.message);
    if (state === undefined) return;
    realtimeActive = state;
    if (!state) mutedByFocus = false;
  });

  pi.on("session_shutdown", () => {
    stopInput?.();
    stopInput = undefined;
    realtimeActive = false;
    mutedByFocus = false;
  });

  pi.registerCommand("live", {
    description: "Toggle Codex realtime voice",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /live", "warning");
        return;
      }
      const wasActive = realtimeActive;
      const wasMutedByFocus = mutedByFocus;
      realtimeActive = !wasActive;
      if (wasActive) mutedByFocus = false;
      try {
        dispatch(wasActive ? "/codex voice stop" : "/codex voice realtime");
      } catch (error) {
        realtimeActive = wasActive;
        mutedByFocus = wasMutedByFocus;
        throw error;
      }
    },
  });
}
