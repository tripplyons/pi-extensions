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
  let realtimeActive = false;
  let focused = true;
  let mutedByFocus = false;
  let focusReporting = false;
  let stopInput: (() => void) | undefined;

  const dispatch = (command: string) => {
    pi.sendUserMessage(command, { expandPromptTemplates: true });
  };

  const setFocusMute = (muted: boolean) => {
    dispatch(`/codex voice mute ${muted ? "on" : "off"}`);
    mutedByFocus = muted;
  };

  pi.on("session_start", (_event, ctx) => {
    realtimeActive = false;
    focused = true;
    mutedByFocus = false;
    focusReporting = false;
    stopInput?.();
    stopInput = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const state = realtimeState(entry.message);
      if (state !== undefined) realtimeActive = state;
    }
    focusReporting = ctx.mode === "tui" && process.stdout.isTTY === true && process.env.OVERSEER === "1";
    if (focusReporting) {
      process.stdout.write(ENABLE_FOCUS_REPORTING);
      stopInput = ctx.ui.onTerminalInput((data) => {
        if (data === "\x1b[O") {
          focused = false;
          if (realtimeActive && !mutedByFocus) setFocusMute(true);
        } else if (data === "\x1b[I") {
          focused = true;
          if (realtimeActive && mutedByFocus) setFocusMute(false);
        }
      });
    }
  });

  pi.on("message_end", (event) => {
    const state = realtimeState(event.message);
    if (state === undefined) return;
    realtimeActive = state;
    if (!state) {
      mutedByFocus = false;
    } else if (!focused && !mutedByFocus) {
      setFocusMute(true);
    }
  });

  pi.on("session_shutdown", () => {
    stopInput?.();
    stopInput = undefined;
    if (focusReporting) process.stdout.write(DISABLE_FOCUS_REPORTING);
    realtimeActive = false;
    mutedByFocus = false;
    focusReporting = false;
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
        if (!wasActive && !focused) setFocusMute(true);
      } catch (error) {
        realtimeActive = wasActive;
        mutedByFocus = wasMutedByFocus;
        throw error;
      }
    },
  });
}
