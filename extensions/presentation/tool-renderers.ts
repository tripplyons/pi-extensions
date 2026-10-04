import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { argumentProgress, renderResult, resultSummary, toolCall, writingArguments } from "../../lib/tool-preview.ts";

// Keep presentation state separate from state owned by the delegated renderer.
export function compactToolRenderers(name: string, next?: ToolRenderers, streamedArgs?: (id: string) => Record<string, unknown> | undefined): ToolRenderers {
  const summaries = new WeakMap<object, string>();
  const call = toolCall(name);
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const input = writingArguments(context) && Object.keys(args ?? {}).length === 0 ? streamedArgs?.(context.toolCallId) ?? args : args;
      if (context.expanded) return (next?.renderCall ?? call)(input, theme, context);
      const title = call(input, theme, context);
      return {
        invalidate() { title.invalidate(); },
        render(width) {
          const summary = writingArguments(context) ? `writing ${argumentProgress(input).chars} chars`
            : summaries.get(context.state) ?? (context.executionStarted ? "running" : "pending");
          return compactLines(title, summary, width, theme, context.isError);
        },
      };
    },
    renderResult(result, options, theme, context) {
      summaries.set(context.state, executionSummary(name, result, context.isError, options.isPartial));
      if (options.expanded) return (next?.renderResult ?? renderResult)(result, options, theme, context);
      return { invalidate() {}, render() { return []; } };
    },
  };
}

function compactLines(title: Component, summary: string, width: number, theme: Theme, isError: boolean): string[] {
  // Reserve the outcome before laying out arguments, so a streaming tail stays visible.
  const suffixWidth = Math.min(visibleWidth(summary) + 3, Math.floor(width * 0.45));
  const text = truncateToWidth(` · ${summary}`, suffixWidth);
  const available = Math.max(0, width - visibleWidth(text));
  const lines = title.render(available);
  const suffix = theme.fg(isError ? "error" : "muted", text);
  return lines.map(line => truncateToWidth(line, available) + suffix);
}

function executionSummary(name: string, result: { content: Array<{ type: string; text?: string }>; details?: any }, isError: boolean, isPartial: boolean): string {
  if (name !== "codemode" || isError || !isPartial || !Array.isArray(result.details?.calls)) return resultSummary(result, isError, isPartial);
  const calls = result.details.calls.filter((call: any) => call && typeof call.name === "string" && ["running", "ok", "error", "cancelled"].includes(call.status));
  const active = calls.findLast((call: any) => call.status === "running");
  const latest = active ?? calls.at(-1);
  if (!latest) return resultSummary(result, isError, isPartial);
  const done = calls.filter((call: any) => call.status !== "running").length;
  const label = stripTerminalSequences(latest.name).replace(/[\x00-\x1f\x7f]/g, "");
  return `${active ? "running" : latest.status} ${label} (${done}/${calls.length} done)`;
}

// Bound display-only JSON recovery independently of the provider's execution input.
export const MAX_STREAM_ARGUMENT_CHARS = 1_048_576;

export function registerCompactToolRenderers(pi: ExtensionAPI) {
  const streams = new Map<string, { json?: string; args?: Record<string, unknown> }>();
  pi.on("message_update", event => {
    const update = event.assistantMessageEvent;
    if (update.type !== "toolcall_delta") return;
    const block = update.partial.content[update.contentIndex];
    if (block?.type !== "toolCall") return;
    const previous = streams.get(block.id);
    if (previous && previous.json === undefined) return;
    const json = (previous?.json ?? "") + update.delta;
    if (json.length > MAX_STREAM_ARGUMENT_CHARS) { streams.set(block.id, {}); return; }
    // Some providers emit raw deltas but parse arguments only after the JSON closes.
    // Recover a preview without mutating the assistant message or execution arguments.
    const parsed = Object.keys(block.arguments ?? {}).length === 0 ? parseStreamingJson<unknown>(json) : undefined;
    const args = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    streams.set(block.id, { json, args });
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    for (const block of event.message.content) if (block.type === "toolCall") streams.delete(block.id);
  });
  const clear = () => { streams.clear(); };
  pi.on("agent_end", clear);
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);
  pi.registerToolRenderer((name, next) => compactToolRenderers(name, next(), id => streams.get(id)?.args));
}
