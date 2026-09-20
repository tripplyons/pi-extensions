import { expect, test } from "bun:test";
import { Container, TuiAltScreen, type Component } from "@earendil-works/pi-tui";
import { compactEditorLayout } from "./layout.ts";

// Exercise Pi's actual dock and layout allocator, including its editor minimum.
const { createChatViewport } = await import(new URL("./modes/interactive/chat-viewport.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const { renderLayoutFrame } = await import(new URL("./layout.js", import.meta.resolve("@earendil-works/pi-tui")).href);

function setup() {
  let lines = ["input"];
  const editor: Component = { render: () => lines, invalidate() {} };
  const container = new Container();
  container.addChild(editor);
  const widgetsBelow = new Container();
  const { root } = createChatViewport({
    document: new Container(), pendingMessages: new Container(), status: new Container(),
    editor: container, widgetsBelow,
    footer: { render: () => ["footer"], invalidate() {} },
  });
  const tui = new TuiAltScreen({ rows: 24, columns: 80 } as never);
  tui.setLayoutRoot(root);
  return {
    tui, root, editor, container, widgetsBelow,
    setLines(value: string[]) { lines = value; },
    render() { return renderLayoutFrame(root, 80, 24, () => {}).lines.map((line: string) => line.trimEnd()); },
  };
}

test("fullscreen footer follows compact input without reserved blank rows", () => {
  const h = setup();
  expect(h.render().slice(-4)).toEqual(["input", "", "", "footer"]);
  const restore = compactEditorLayout(h.tui, h.editor);
  for (const lines of [["input"], ["first", "second"], ["first", "second", "third", "fourth"], []]) {
    h.setLines(lines);
    const output = h.render();
    expect(output.slice(-(lines.length + 1))).toEqual([...lines, "footer"]);
    expect(h.root.render(80)).toEqual(["", ...lines, "footer"]);
  }
  h.setLines(["input"]);
  restore();
  expect(h.render().slice(-4)).toEqual(["input", "", "", "footer"]);
});

test("preserves completion rows and below-editor widgets", () => {
  const h = setup();
  const restore = compactEditorLayout(h.tui, h.editor);
  h.setLines(["input", "completion"]);
  h.widgetsBelow.addChild({ render: () => ["widget"], invalidate() {} });
  expect(h.render().slice(-4)).toEqual(["input", "completion", "widget", "footer"]);
  restore();
});

test("retains the minimum for selectors that temporarily replace the editor", () => {
  const h = setup();
  const restore = compactEditorLayout(h.tui, h.editor);
  h.render();
  h.container.clear();
  h.container.addChild({ render: () => ["selector"], invalidate() {} });
  expect(h.render().slice(-4)).toEqual(["selector", "", "", "footer"]);
  h.container.clear();
  h.container.addChild(h.editor);
  expect(h.render().slice(-2)).toEqual(["input", "footer"]);
  restore();
});

test("handles regular mode and a later fullscreen layout root", () => {
  const h = setup();
  h.tui.setLayoutRoot(undefined);
  const render = h.editor.render;
  const restore = compactEditorLayout(h.tui, h.editor);
  expect(h.editor.render(80)).toEqual(["input"]);
  h.tui.setLayoutRoot(h.root);
  expect(h.render().slice(-2)).toEqual(["input", "footer"]);
  restore();
  expect(h.editor.render).toBe(render);
});
