import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// Format structured results without quoting or escaping their text payloads.
export function previewText(value: unknown): string {
  if (value == null) return "None";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    return value.length ? value.map(item => `- ${previewText(item).replaceAll("\n", "\n  ")}`).join("\n") : "None";
  }
  return Object.entries(value).map(([key, item]) => {
    const label = key.replace(/([a-z])([A-Z])/g, (_, lower, upper) => `${lower} ${upper.toLowerCase()}`).replaceAll("_", " ");
    const heading = label.charAt(0).toUpperCase() + label.slice(1);
    const body = previewText(item);
    return body.includes("\n") ? `${heading}:\n${body}` : `${heading}: ${body}`;
  }).join("\n") || "None";
}

export const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result, { expanded }, theme, context) => {
  const content = context.isError || result.details === undefined
    ? result.content.filter(block => block.type === "text").map(block => block.text).join("\n")
    : previewText(result.details);
  const text = new Text(theme.fg(context.isError ? "error" : "toolOutput", content), 0, 0);
  return {
    invalidate() { text.invalidate(); },
    render(width) {
      const lines = text.render(width);
      if (expanded || lines.length <= 8) return lines;
      return [...lines.slice(0, 8), ...new Text(theme.fg("muted", "… Expand for more"), 0, 0).render(width)];
    },
  };
};

export function toolCall(name: string): NonNullable<ToolDefinition["renderCall"]> {
  return (args, theme) => {
    const title = theme.fg("accent", theme.bold(name));
    if (name === "ask_user") {
      const question = typeof args?.question === "string" ? args.question : "...";
      return new Text(title + theme.fg("text", ` ${question}`), 0, 0);
    }
    if (name === "grep" || name === "glob") {
      const pattern = typeof args?.pattern === "string" ? args.pattern : "...";
      const path = typeof args?.path === "string" ? ` in ${args.path}` : "";
      return new Text(title + theme.fg("text", ` ${pattern}${path}`), 0, 0);
    }
    if (!["read", "edit", "write"].includes(name)) return new Text(title, 0, 0);
    const path = typeof args?.path === "string" ? args.path : "...";
    const range = [
      typeof args?.offset === "number" ? `offset: ${args.offset}` : undefined,
      typeof args?.limit === "number" ? `limit: ${args.limit}` : undefined,
    ].filter(Boolean);
    const suffix = range.length ? ` (${range.join(", ")})` : "";
    return new Text(title + theme.fg("text", ` ${path}${suffix}`), 0, 0);
  };
}
