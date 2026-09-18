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
  h.ctx.ui.theme = { bg: (_token: string, text: string) => `\x1b[48;2;48;43;41m${text}\x1b[49m` };
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

test("native editor has a tinted background without rules and keeps cursor/mouse layout", async () => {
  const factory = await setup();
  const editor = factory(tui, theme, keybindings);
  editor.focused = true;
  editor.setText("hello");
  const output = editor.render(20);
  expect(output).toHaveLength(1);
  expect(output.every(line => line.includes("\x1b[48;2;48;43;41m"))).toBe(true);
  expect(output.join("\n")).not.toContain("─");
  expect(output.join("\n")).toContain("hello");
  editor.handleMouse({ type: "click", button: "left", x: 2, y: 0, width: 20, height: 1 });
  expect(editor.getCursor()).toEqual({ line: 0, col: 2 });
  editor.setText("");
  expect(editor.render(20)).toEqual([]);
});

test("compact editor preserves literal rules, completion rows, and completion mouse offsets", async () => {
  const editor = new CustomEditor(tui as never, theme as never, keybindings as never);
  editor.render = () => ["────", "────", "────", "completion"];
  let mouse: any;
  editor.handleMouse = event => { mouse = event; return { handled: true }; };
  const factory = await setup(() => editor);
  const compact = factory(tui, theme, keybindings);
  compact.setText("────");
  const lines = compact.render(4);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("────");
  expect(lines[1]).toBe("completion");
  compact.handleMouse({ type: "click", button: "left", x: 0, y: 1, width: 4, height: 2 });
  expect(mouse.y).toBe(3);
});

test("nonempty input colors every column, including padding after the cursor reset", async () => {
  const factory = await setup();
  const editor = factory(tui, theme, keybindings);
  editor.focused = true;
  for (const width of [20, 80]) {
    for (const text of ["hello", " ", "a".repeat(100), "first\nsecond"]) {
      editor.setText(text);
      for (const line of editor.render(width)) {
        let background = false;
        let columns = 0;
        // Track terminal background state, not just the presence of a color code.
        for (const token of line.match(/\x1b\[[0-9;]*m|\x1b_[\s\S]*?\x07|./g) ?? []) {
          if (token === "\x1b[48;2;48;43;41m") background = true;
          else if (/^\x1b\[(?:0|49)?m$/.test(token)) background = false;
          else if (!token.startsWith("\x1b")) {
            expect(background).toBe(true);
            columns++;
          }
        }
        expect(columns).toBe(width);
      }
    }
  }
});
