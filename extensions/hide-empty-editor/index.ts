import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function hideEmptyEditorExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI === false || (ctx.mode !== undefined && ctx.mode !== "tui")) return;

		// OMP has no getEditorComponent API; use its default editor when no prior factory is available.
		const previous = ctx.ui.getEditorComponent?.();
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
