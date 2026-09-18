import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderResult } from "../../lib/tool-preview.ts";

export const renderSleepCall: NonNullable<ToolDefinition["renderCall"]> = (args, theme, context) => ({
  invalidate() {},
  render(width) {
    const duration = typeof args?.seconds === "number" ? `${args.seconds}s` : "...";
    const remaining = context.state.remaining;
    const countdown = typeof remaining === "number" ? ` - ${remaining.toFixed(1)}s remaining` : "";
    return [truncateToWidth(theme.fg("toolTitle", `sleep ${duration}${countdown}`), width)];
  },
});

export const renderSleepResult: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme, context) => {
  context.state.remaining = options.isPartial ? result.details?.remaining : undefined;
  if (options.isPartial) return { invalidate() {}, render() { return []; } };
  return renderResult(result, options, theme, context);
};
