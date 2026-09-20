import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, stripTerminalSequences } from "@earendil-works/pi-tui";
import { compactEditorLayout } from "./layout.ts";

export default function hideEmptyEditor(pi: ExtensionAPI) {
  let restoreLayout: (() => void) | undefined;
  pi.on("session_shutdown", () => { restoreLayout?.(); restoreLayout = undefined; });
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previous
        ? previous(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings);
      const render = editor.render.bind(editor);
      // Remove border rows without changing completion styling.
      let contentRows: number | undefined;
      const handleMouse = editor.handleMouse?.bind(editor);
      if (handleMouse) editor.handleMouse = event => contentRows === undefined ? handleMouse(event) : handleMouse({
        ...event, y: event.y + (event.y >= contentRows ? 2 : 1),
        height: event.height + 2,
      });
      let lines: string[] = [];
      const background = new Box(0, 0, text => {
        // The editor's cursor resets all styles. Restore the input background
        // after that reset so the rest of the row stays tinted too.
        const start = ctx.ui.theme.bg("userMessageBg", "").replace(/\x1b\[49m$/, "");
        return ctx.ui.theme.bg("userMessageBg", text.replace(/\x1b\[(?:0|49)?m/g, reset => reset + start));
      });
      background.addChild({ render: () => lines, invalidate() {} });
      editor.render = (width) => {
        contentRows = undefined;
        if (editor.getText().length === 0) return [];
        const output = render(width);
        const bottom = output.findLastIndex((line, index) => index > 0 && /^─+(?: ↓ \d+ more )?─*$/.test(stripTerminalSequences(line)));
        if (bottom < 0) return output;
        lines = output.slice(1, bottom);
        contentRows = lines.length;
        background.invalidate();
        return [...background.render(width), ...output.slice(bottom + 1)];
      };
      restoreLayout?.();
      restoreLayout = compactEditorLayout(tui, editor);
      return editor;
    });
  });
}
