import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export function compactUserRows(lines: string[]): string[] {
  if (lines.length < 3 || stripTerminalSequences(lines[0]).trim() || stripTerminalSequences(lines.at(-1)!).trim()) return lines;
  const content = lines.slice(1, -1);
  // Preserve Pi's terminal prompt-zone markers when dropping the padding rows.
  const zones = (line: string) => line.match(/\x1b\]133;[ABC]\x07/g)?.join("") ?? "";
  content[0] = zones(lines[0]) + content[0];
  content[content.length - 1] += zones(lines.at(-1)!);
  return content;
}

export function installCompactUserMessages(): () => void {
  // Pi has no renderer hook for native user messages. Keep this override local
  // to the exported component and undo it when the extension shuts down.
  const original = UserMessageComponent.prototype.render;
  const render = function (this: UserMessageComponent, width: number) {
    return compactUserRows(original.call(this, width));
  };
  UserMessageComponent.prototype.render = render;
  return () => {
    if (UserMessageComponent.prototype.render === render) UserMessageComponent.prototype.render = original;
  };
}
