import { describe, expect, test } from "bun:test";

import stashExtension from "./index.ts";

type ShortcutHandler = (ctx: any) => Promise<void>;

const createHarness = (initialText = "") => {
	let editorText = initialText;
	let shortcut: ShortcutHandler | undefined;

	stashExtension({
		registerShortcut(key: string, options: { handler: ShortcutHandler }) {
			expect(key).toBe("ctrl+s");
			shortcut = options.handler;
		},
	} as any);

	const pressShortcut = () => shortcut!({
		ui: {
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
	});

	return {
		getEditorText: () => editorText,
		pressShortcut,
		setEditorText: (text: string) => {
			editorText = text;
		},
	};
};

describe("stash shortcut", () => {
	test("stashes, restores, and swaps editor contents", async () => {
		const harness = createHarness("first draft");

		await harness.pressShortcut();
		expect(harness.getEditorText()).toBe("");

		await harness.pressShortcut();
		expect(harness.getEditorText()).toBe("first draft");

		harness.setEditorText("replacement draft");
		await harness.pressShortcut();
		expect(harness.getEditorText()).toBe("");

		harness.setEditorText("third draft");
		await harness.pressShortcut();
		expect(harness.getEditorText()).toBe("replacement draft");

		await harness.pressShortcut();
		expect(harness.getEditorText()).toBe("third draft");
	});
});
