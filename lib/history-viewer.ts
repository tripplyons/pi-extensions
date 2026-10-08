import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";

export type ViewerAction = "close" | "refresh" | "older" | "expand" | "more" | "entry";

// A temporary read-only screen. Nothing is appended to the model's conversation.
export async function viewHistory(ctx: ExtensionContext, title: string, body: string, options: { older?: boolean; expand?: boolean; more?: boolean; entry?: boolean } = {}): Promise<ViewerAction> {
  if (ctx.mode !== "tui") throw new Error("History inspection screens require interactive Pi; use the read-only tools in other modes");
  return ctx.ui.custom<ViewerAction>((tui, theme, _keys, done) => {
    const content = new Text(stripTerminalSequences(body), 0, 0);
    const scroll = new ScrollView(content);
    const hint = `↑↓/PgUp/PgDn scroll | r refresh${options.older ? " | p older" : ""}${options.expand ? " | e expand summary" : ""}${options.more ? " | n more text" : ""}${options.entry ? " | o open entry" : ""} | Esc back`;
    return {
      invalidate() { content.invalidate(); },
      render(width: number) {
        const lines = scroll.render(width), height = Math.max(1, tui.terminal.rows - 4);
        scroll.updateLayout(lines.length, height, () => tui.requestRender());
        return [truncateToWidth(theme.fg("accent", stripTerminalSequences(title)), width),
          ...lines.slice(scroll.scrollTop, scroll.scrollTop + height).map(line => truncateToWidth(line, width)), truncateToWidth(theme.fg("dim", hint), width)];
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape") || data === "q") return done("close");
        if (data === "r") return done("refresh");
        if (data === "p" && options.older) return done("older");
        if (data === "e" && options.expand) return done("expand");
        if (data === "n" && options.more) return done("more");
        if (data === "o" && options.entry) return done("entry");
        if (matchesKey(data, "up") || data === "k") scroll.scrollBy(-1);
        else if (matchesKey(data, "down") || data === "j") scroll.scrollBy(1);
        else if (matchesKey(data, "pageUp")) scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1));
        else if (matchesKey(data, "pageDown")) scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1));
        else if (matchesKey(data, "home")) scroll.scrollToStart();
        else if (matchesKey(data, "end")) scroll.scrollToEnd();
        tui.requestRender();
      },
    };
  });
}
