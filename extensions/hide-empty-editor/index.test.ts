import { expect, test } from "bun:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import install from "./index.ts";
import { harness } from "../../lib/harness.ts";

const tui = { terminal: { rows: 24 }, requestRender() {} };
const theme = { borderColor: (text: string) => text };
const keybindings = { matches: () => false };

async function setup(previous?: () => CustomEditor, mode = "tui", hasUI = true) {
  const h = harness();
  let factory: any;
  h.ctx.mode = mode;
  h.ctx.hasUI = hasUI;
  h.ctx.ui.getEditorComponent = () => previous;
  h.ctx.ui.setEditorComponent = (value: any) => { factory = value; };
  install(h.pi);
  await h.emit("session_start");
  return factory;
}

test("hides the empty editor, shows typed input, and hides again after clearing", async () => {
  const factory = await setup();
  const editor = factory(tui, theme, keybindings);
  expect(editor).toBeInstanceOf(CustomEditor);
  expect(editor.render(80)).toEqual([]);
  editor.handleInput("hello");
  expect(editor.getText()).toBe("hello");
  expect(editor.render(80).join("\n")).toContain("hello");
  editor.setText("");
  expect(editor.render(80)).toEqual([]);
  editor.setText(" ");
  expect(editor.render(80).length).toBeGreaterThan(0);
});

test("preserves an existing editor and its rendering", async () => {
  const previous = new CustomEditor(tui as never, theme as never, keybindings as never);
  previous.render = (width) => [`custom:${width}:${previous.getText()}`];
  const factory = await setup(() => previous);
  const editor = factory(tui, theme, keybindings);
  expect(editor).toBe(previous);
  expect(editor.render(80)).toEqual([]);
  editor.setText("hello");
  expect(editor.render(80)).toEqual(["custom:80:hello"]);
});

test("does not replace editors outside interactive TUI mode", async () => {
  expect(await setup(undefined, "rpc")).toBeUndefined();
  expect(await setup(undefined, "tui", false)).toBeUndefined();
});
