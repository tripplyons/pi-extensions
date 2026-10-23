import { expect, test } from "bun:test";
import { getKeybindings, stripTerminalSequences, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";

for (const mode of ["regular", "fullscreen"]) test(`real ${mode} TUI renders, scrolls, resizes, and closes the question overlay`, async () => {
  let input = (_data: string) => {}, resize = () => {};
  const terminal = {
    rows: 8, columns: 40, kittyProtocolActive: false,
    start(onInput: typeof input, onResize: typeof resize) { input = onInput; resize = onResize; },
    async drainInput() {}, stop() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const h = harness(); install(h.pi);
  (h.ctx as any).mode = "tui";
  h.ctx.ui.custom = (factory: any, options: any) => new Promise(resolve => {
    let component: any, handle: any;
    component = factory(tui, { fg: (_color: string, text: string) => text }, getKeybindings(), (answer: any) => {
      handle?.hide();
      component?.dispose();
      resolve(answer);
    });
    handle = tui.showOverlay(component, options.overlayOptions);
  });
  const screen = () => {
    tui.renderNow(true);
    return (tui instanceof TuiAltScreen ? tui.getScreenLines() : tui.captureRenderState().previousLines)
      .map(line => stripTerminalSequences(line).trimEnd());
  };
  tui.start();
  try {
    const question = Array.from({ length: 30 }, (_, index) => `q${String(index).padStart(2, "0")}: question`).join("\n");
    const pending = h.call("ask_user", { question, choices: ["A"] });
    expect(tui.hasOverlay()).toBe(true);
    expect(screen().join("\n")).toContain("q00:");
    expect(screen().join("\n")).toContain("→ A");
    input("\x1b[6~");
    expect(screen().join("\n")).toContain("q02:");
    if (mode === "fullscreen") {
      input("\x1b[<65;2;2M");
      expect(screen().join("\n")).toContain("q03:");
    }
    terminal.rows = 5;
    terminal.columns = 22;
    resize();
    expect(screen().length).toBeLessThanOrEqual(5);
    expect(screen().join("\n")).toContain("→ A");
    expect(screen().join("\n")).toContain("PgUp/PgDn");
    input("\r");
    expect((await pending).details).toEqual({ answer: "A", choice: 1 });
    expect(tui.hasOverlay()).toBe(false);

    const typed = h.call("ask_user", { question, choices: [] });
    screen();
    input("hello");
    expect(screen().join("\n")).toContain("> hello");
    input("\x1b[6~");
    expect(screen().join("\n")).toContain("q02:");
    expect(screen().join("\n")).toContain("> hello");
    input("\r");
    expect((await typed).details).toEqual({ answer: "hello" });
    expect(tui.hasOverlay()).toBe(false);
  } finally {
    tui.stop();
  }
});
