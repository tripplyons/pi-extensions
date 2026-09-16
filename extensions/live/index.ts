import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VOICE_MODE_MESSAGE_TYPE = "codex-voice-mode";
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";

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
  let liveEnabled = false;
  let realtimeActive = false;
  let focused = true;
  let suspendedByFocus = false;
  let focusReporting = false;
  let stopInput: (() => void) | undefined;

  const dispatch = (command: string) => {
    pi.sendUserMessage(command, { expandPromptTemplates: true });
  };

  pi.on("session_start", (_event, ctx) => {
    liveEnabled = false;
    realtimeActive = false;
    focused = true;
    suspendedByFocus = false;
    focusReporting = false;
    stopInput?.();
    stopInput = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const state = realtimeState(entry.message);
      if (state === undefined) continue;
      realtimeActive = state;
      liveEnabled = state;
    }
    focusReporting = ctx.mode === "tui" && process.stdout.isTTY === true && process.env.OVERSEER === "1";
    if (focusReporting) {
      process.stdout.write(ENABLE_FOCUS_REPORTING);
      stopInput = ctx.ui.onTerminalInput((data) => {
        if (data === "\x1b[O") {
          focused = false;
          if (!liveEnabled || !realtimeActive) return;
          suspendedByFocus = true;
          realtimeActive = false;
          try {
            dispatch("/codex voice stop");
          } catch (error) {
            suspendedByFocus = false;
            realtimeActive = true;
            throw error;
          }
        } else if (data === "\x1b[I") {
          focused = true;
          if (!liveEnabled || !suspendedByFocus) return;
          suspendedByFocus = false;
          realtimeActive = true;
          try {
            dispatch("/codex voice realtime");
          } catch (error) {
            suspendedByFocus = true;
            realtimeActive = false;
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
    if (state) {
      liveEnabled = true;
      suspendedByFocus = false;
    } else if (!suspendedByFocus) {
      liveEnabled = false;
    }
  });

  pi.on("session_shutdown", () => {
    stopInput?.();
    stopInput = undefined;
    if (focusReporting) process.stdout.write(DISABLE_FOCUS_REPORTING);
    liveEnabled = false;
    realtimeActive = false;
    suspendedByFocus = false;
    focusReporting = false;
  });

  pi.registerCommand("live", {
    description: "Toggle Codex realtime voice",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /live", "warning");
        return;
      }
      const previous = { liveEnabled, realtimeActive, suspendedByFocus };
      liveEnabled = !liveEnabled;
      if (!liveEnabled) {
        suspendedByFocus = false;
        if (!realtimeActive) return;
        realtimeActive = false;
        try {
          dispatch("/codex voice stop");
        } catch (error) {
          ({ liveEnabled, realtimeActive, suspendedByFocus } = previous);
          throw error;
        }
        return;
      }
      if (!focused) {
        suspendedByFocus = true;
        return;
      }
      realtimeActive = true;
      try {
        dispatch("/codex voice realtime");
      } catch (error) {
        ({ liveEnabled, realtimeActive, suspendedByFocus } = previous);
        throw error;
      }
    },
  });
}
