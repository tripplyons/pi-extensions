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
