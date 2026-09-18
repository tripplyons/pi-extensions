import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

class CommandText extends Text {
  expanded = false;
  private content = "";

  override setText(text: string) {
    this.content = text;
    super.setText(text);
  }

  override render(width: number): string[] {
    if (this.expanded) return super.render(width);
    return this.content.split("\n").map(line => truncateToWidth(line.replaceAll("\t", "   "), width));
  }
}

export const renderCall: NonNullable<ToolDefinition["renderCall"]> = (args, theme, context) => {
  const text = context.lastComponent instanceof CommandText ? context.lastComponent : new CommandText("", 0, 0);
  text.expanded = context.expanded;
  const lines = typeof args?.command === "string" ? args.command.split(/\r?\n/) : ["..."];
  const hidden = lines.length - 6;
  const preview = !context.expanded && hidden > 0
    ? [...lines.slice(0, 3), `... (${hidden} ${hidden === 1 ? "line" : "lines"} hidden)`, ...lines.slice(-3)]
    : lines;
  text.setText(theme.fg("toolTitle", `$ ${preview.join("\n")}`));
  return text;
};
