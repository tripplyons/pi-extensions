import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function hideEmptyEditor(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = previous
        ? previous(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings);
      const render = editor.render.bind(editor);
      editor.render = (width) => editor.getText().length === 0 ? [] : render(width);
      return editor;
    });
  });
}
