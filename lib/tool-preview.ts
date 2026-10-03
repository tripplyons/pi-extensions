import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

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

export const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result, { expanded, isPartial }, theme, context) => {
  if (!expanded) return {
    invalidate() {},
    render(width) { return [truncateToWidth(theme.fg(context.isError ? "error" : "muted", resultSummary(result, context.isError, isPartial)), width)]; },
  };
  const content = context.isError || result.details === undefined
    ? result.content.filter(block => block.type === "text").map(block => block.text).join("\n")
    : previewText(result.details);
  const text = new Text(theme.fg(context.isError ? "error" : "toolOutput", content), 0, 0);
  return {
    invalidate() { text.invalidate(); },
    render(width) {
      return text.render(width);
    },
  };
};

function singleLine(value: string): string {
  return stripTerminalSequences(value).replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").replace(/ +/g, " ").trim();
}

export function resultSummary(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, isError = false, isPartial = false): string {
  const output = result.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
  let readable = output;
  if (!isError && /^[\s]*[\[{]/.test(output)) {
    try { readable = previewText(JSON.parse(output)); } catch { /* Plain text can start with a brace. */ }
  }
  const lines = readable.split(/\r?\n/).filter(line => singleLine(line));
  const first = lines[0] ?? "";
  const heading = first.trimEnd().endsWith(":") && lines[1] ? `${first} ${lines[1]}` : first;
  const images = result.content.filter(block => block.type === "image").length;
  const summary = singleLine(heading) || (images ? `${images} ${images === 1 ? "image" : "images"}` : "");
  if (isError) return `error${summary ? `: ${summary}` : ""}`;
  if (isPartial) return summary || "running";
  return summary || "done";
}

export function toolCall(name: string): NonNullable<ToolDefinition<any>["renderCall"]> {
  return (input, theme, context) => {
    const args = (input ?? {}) as Record<string, unknown>;
    const title = theme.fg("accent", name === "bash" ? "$" : theme.bold(name));
    const preview = (value: string) => ({
      invalidate() {},
      render(width: number) {
        const content = title + theme.fg("text", value ? ` ${singleLine(value)}` : "");
        if (!context?.expanded) return [truncateToWidth(content, width)];
        return new Text(title + theme.fg("text", value ? ` ${value}` : ""), 0, 0).render(width);
      },
    });
    if (name === "bash") return preview(typeof args.command === "string" ? args.command : "...");
    if (name === "ask_user") {
      const question = typeof args?.question === "string" ? args.question : "...";
      return preview(question);
    }
    if (name === "web_search" || name === "web_extract") {
      const value = name === "web_search" ? args?.query : args?.url;
      const options = [
        args?.provider ?? "openai-codex",
        `${args?.timeout ?? 30}s timeout`,
        typeof args?.max_results === "number" ? `results: ${args.max_results}` : undefined,
        typeof args?.timelimit === "string" ? `recent: ${args.timelimit}` : undefined,
        typeof args?.max_chars === "number" ? `chars: ${args.max_chars}` : undefined,
      ].filter(Boolean);
      return preview(`${typeof value === "string" ? value : "..."} (${options.join(", ")})`);
    }
    if (name === "grep" || name === "find") {
      const pattern = typeof args?.pattern === "string" ? args.pattern : "...";
      const path = typeof args?.path === "string" ? ` in ${args.path}` : "";
      return preview(`${pattern}${path}`);
    }
    if (!["read", "edit", "write", "ls"].includes(name)) {
      const key = ["question", "query", "url", "path", "pattern", "task_id", "nodeId", "objective", "status", "command"].find(key => typeof args[key] === "string");
      if (key) return preview(String(args[key]));
      const scalar = Object.entries(args).find(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean");
      if (scalar) return preview(`${scalar[0]}: ${scalar[1]}`);
      if (Array.isArray(args.todos)) return preview(`${args.todos.length} tasks`);
      return preview("");
    }
    const path = typeof args?.path === "string" ? args.path : name === "ls" ? "." : "...";
    const range = [
      typeof args?.offset === "number" ? `offset: ${args.offset}` : undefined,
      typeof args?.limit === "number" ? `limit: ${args.limit}` : undefined,
    ].filter(Boolean);
    const suffix = range.length ? ` (${range.join(", ")})` : "";
    return preview(`${path}${suffix}`);
  };
}
