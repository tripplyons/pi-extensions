import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderResult, resultSummary, toolCall } from "../../lib/tool-preview.ts";

// Keep presentation state separate from state owned by the delegated renderer.
export function compactToolRenderers(name: string, next?: ToolRenderers): ToolRenderers {
  const summaries = new WeakMap<object, string>();
  const call = toolCall(name);
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      if (context.expanded) return (next?.renderCall ?? call)(args, theme, context);
      const title = call(args, theme, context);
      return {
        invalidate() { title.invalidate(); },
        render(width) {
          const summary = summaries.get(context.state) ?? (context.executionStarted ? "running" : "pending");
          return title.render(width).map(line => compactLine(line, summary, width, theme, context.isError));
        },
      };
    },
    renderResult(result, options, theme, context) {
      summaries.set(context.state, resultSummary(result, context.isError, options.isPartial));
      if (options.expanded) return (next?.renderResult ?? renderResult)(result, options, theme, context);
      return { invalidate() {}, render() { return []; } };
    },
  };
}

function compactLine(title: string, summary: string, width: number, theme: Theme, isError: boolean): string {
  // Reserve space for the outcome even when the argument is a long path or command.
  const suffixWidth = Math.min(visibleWidth(summary) + 3, Math.floor(width * 0.45));
  const suffix = truncateToWidth(theme.fg(isError ? "error" : "muted", ` · ${summary}`), suffixWidth);
  return truncateToWidth(title, Math.max(0, width - visibleWidth(suffix))) + suffix;
}

export function registerCompactToolRenderers(pi: ExtensionAPI) {
  pi.registerToolRenderer((name, next) => compactToolRenderers(name, next()));
}
