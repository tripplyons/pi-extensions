import { describe, expect, mock, test } from "bun:test";

class MockEditor {
	#text = "";

	getText() {
		return this.#text;
	}

	setText(text: string) {
		this.#text = text;
	}

	render(width: number) {
		return [`editor:${width}:${this.#text}`];
	}
}

mock.module("@earendil-works/pi-coding-agent", () => ({
	CustomEditor: MockEditor,
}));

// Dynamic import is required so Bun installs the host-package mock before loading the extension.
const { default: hideEmptyEditorExtension } = await import("./index.ts");

type SessionStart = (event: unknown, ctx: unknown) => void;
type EditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => MockEditor;

function registerExtension() {
	let sessionStart: SessionStart | undefined;
	hideEmptyEditorExtension({
		on(event: string, handler: SessionStart) {
			if (event === "session_start") sessionStart = handler;
		},
	} as never);
	return () => sessionStart;
}

function expectEmptyEditorHidden(editor: MockEditor) {
	expect(editor.render(80)).toEqual([]);
	editor.setText("hello");
	expect(editor.render(80)).toEqual(["editor:80:hello"]);
}

describe("hide-empty-editor", () => {
	test("creates an editor when OMP does not expose getEditorComponent", () => {
		let factory: EditorFactory | undefined;
		const getSessionStart = registerExtension();
		const ui = {
			setEditorComponent(next: EditorFactory) {
				factory = next;
			},
		};

		expect(() => getSessionStart()?.({}, { hasUI: true, ui })).not.toThrow();
		expectEmptyEditorHidden(factory?.({}, {}, {}) as MockEditor);
	});

	test("preserves Pi's previously registered editor", () => {
		const previous = new MockEditor();
		let factory: EditorFactory | undefined;
		const getSessionStart = registerExtension();
		const ui = {
			getEditorComponent: () => () => previous,
			setEditorComponent(next: EditorFactory) {
				factory = next;
			},
		};

		getSessionStart()?.({}, { hasUI: true, mode: "tui", ui });
		const editor = factory?.({}, {}, {});
		expect(editor).toBe(previous);
		expectEmptyEditorHidden(editor as MockEditor);
	});

	test("does not install an editor without UI support", () => {
		let installed = false;
		const getSessionStart = registerExtension();
		const ui = {
			setEditorComponent() {
				installed = true;
			},
		};

		getSessionStart()?.({}, { hasUI: false, ui });
		expect(installed).toBeFalse();
	});
});
