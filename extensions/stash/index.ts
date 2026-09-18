import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let stashedText = "";

	pi.registerShortcut("ctrl+s", {
		description: "Swap the editor contents with the stash buffer",
		handler: async (ctx) => {
			const editorText = ctx.ui.getEditorText();
			ctx.ui.setEditorText(stashedText);
			stashedText = editorText;
		},
	});
}
