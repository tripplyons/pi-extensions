import { expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { CURSOR_MARKER, getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { harness } from "../../lib/harness.ts";
import { askQuestion } from "./dialog.ts";
import install, { other } from "./index.ts";

const down = "\x1b[B", up = "\x1b[A", pageDown = "\x1b[6~", pageUp = "\x1b[5~";
const question = Array.from({ length: 40 }, (_, index) => `q${String(index).padStart(2, "0")}: question details`).join("\n");
const theme = { fg: (_color: string, value: string) => value } as any;

function ui(rows = 8, columns = 40) {
  const h = harness(); install(h.pi);
  (h.ctx as any).mode = "tui";
  const terminal = { rows, columns };
  const dialogs: any[] = [], options: any[] = [];
  let renders = 0;
  const tui = { terminal, requestRender() { renders++; } } as any;
  h.ctx.ui.custom = (factory: any, opts: any) => new Promise(resolve => {
    options.push(opts);
    let component: any;
    component = factory(tui, theme, getKeybindings(), (value: any) => { component?.dispose(); resolve(value); });
    component.focused = true;
    dialogs.push(component);
  });
  const current = () => dialogs.at(-1);
  const raw = () => current().render(terminal.columns) as string[];
  const lines = () => raw().map(line => stripTerminalSequences(line).trimEnd());
  return { h, terminal, dialogs, options, current, raw, lines, renders: () => renders };
}

test("small choice dialogs page through the whole question without changing the answer", async () => {
  const view = ui();
  const pending = view.h.call("ask_user", { question, choices: ["A", "B"] });
  expect(view.options[0]).toMatchObject({ overlay: true, overlayOptions: { maxHeight: "100%" } });
  const seen = new Set<string>();
  let previous = "";
  for (let page = 0; page < 60; page++) {
    const lines = view.lines();
    expect(lines.length).toBeLessThanOrEqual(view.terminal.rows);
    expect(lines.some(line => line === "→ A")).toBe(true);
    for (const line of lines) if (/^q\d\d:/.test(line)) seen.add(line);
    const current = lines.join("\n");
    if (current === previous) break;
    previous = current;
    view.current().handleInput(pageDown);
  }
  expect([...seen].sort()).toEqual(question.split("\n"));
  expect(view.lines().join("\n")).toContain("q39:");
  for (let i = 0; i < 60; i++) view.current().handleInput(pageUp);
  expect(view.lines().join("\n")).toContain("q00:");
  view.current().handleInput(down);
  view.current().handleInput("\r");
  expect((await pending).details).toEqual({ answer: "B", choice: 2 });
});

test("all choices, including Other, remain reachable while the question stays scrolled", async () => {
  const view = ui(6, 40);
  const choices = Array.from({ length: 8 }, (_, index) => `Choice ${index + 1}`);
  const pending = view.h.call("ask_user", { question, choices });
  view.lines();
  view.current().handleInput(pageDown);
  const scrolled = view.lines().find(line => /^q\d/.test(line));
  for (let i = 0; i < 8; i++) {
    expect(view.lines().join("\n")).toContain(`→ Choice ${i + 1}`);
    expect(view.lines().find(line => /^q\d/.test(line))).toBe(scrolled);
    view.current().handleInput(down);
  }
  expect(view.lines().join("\n")).toContain(`→ ${other}`);
  view.current().handleInput("\r");
  await new Promise(setImmediate);
  expect(view.dialogs).toHaveLength(2);
  view.lines();
  view.current().handleInput("custom answer");
  view.current().handleInput(pageDown);
  expect(view.lines().join("\n")).toContain("custom answer");
  view.current().handleInput("\r");
  expect((await pending).details).toEqual({ answer: "custom answer" });
});

test("free-text answers survive scrolling and resize, with input focus and bounded Unicode rows", async () => {
  const view = ui(10, 40);
  const pending = view.h.call("ask_user", { question: `${question}\n全ての設定を表示`, choices: [] });
  expect(view.raw().join("\n")).toContain(CURSOR_MARKER);
  view.current().handleInput("answer");
  for (let i = 0; i < 80; i++) { view.lines(); view.current().handleInput(pageDown); }
  for (const [rows, columns] of [[4, 12], [2, 8], [1, 8], [3, 1], [3, 2], [3, 3], [12, 55], [8, 20]]) {
    view.terminal.rows = rows;
    view.terminal.columns = columns;
    view.current().invalidate();
    const lines = view.lines();
    expect(lines.length).toBeLessThanOrEqual(rows);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
    expect(lines.some(line => line.startsWith(">"))).toBe(true);
    if (columns >= 12) expect(lines.join("\n")).toContain("answer");
  }
  view.current().focused = false;
  expect(view.raw().join("\n")).not.toContain(CURSOR_MARKER);
  view.current().focused = true;
  expect(view.raw().join("\n")).toContain(CURSOR_MARKER);
  view.current().handleInput("\r");
  expect((await pending).content).toEqual([{ type: "text", text: "answer" }]);
});

test("fullscreen wheel events scroll the question without changing the selected choice", async () => {
  const view = ui();
  const pending = view.h.call("ask_user", { question, choices: ["A", "B"] });
  view.lines();
  expect(view.current().handleMouse({ type: "click" })).toBeUndefined();
  expect(view.current().handleMouse({ type: "wheel", wheelDelta: 5 })).toEqual({ handled: true });
  expect(view.lines().join("\n")).toContain("q05:");
  expect(view.lines().join("\n")).toContain("→ A");
  view.current().handleMouse({ type: "wheel", wheelDelta: -100 });
  expect(view.lines().join("\n")).toContain("q00:");
  expect(view.renders()).toBeGreaterThan(0);
  view.current().handleInput("\r");
  expect((await pending).details).toEqual({ answer: "A", choice: 1 });
});

test("wrapped choice labels return their full text and clamp at both ends", async () => {
  const view = ui(12, 20);
  const choices = ["First choice with a wrapped label", "全ての設定を維持する長い選択肢"];
  const pending = view.h.call("ask_user", { question: "Q?", choices });
  view.current().handleInput(up);
  expect(view.lines().join("\n")).toContain("→ First");
  view.current().handleInput("j");
  for (const line of view.lines()) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  view.current().handleInput("\n");
  expect((await pending).details).toEqual({ answer: choices[1], choice: 2 });
});

test("Escape at either TUI step cancels instead of inventing an answer", async () => {
  for (const freeText of [false, true]) {
    const view = ui();
    const pending = view.h.call("ask_user", { question, choices: ["A"] });
    if (freeText) {
      view.current().handleInput(down);
      view.current().handleInput("\r");
      await new Promise(setImmediate);
      expect(view.dialogs).toHaveLength(2);
    }
    view.current().handleInput("\x1b");
    await expect(pending).rejects.toThrow("cancelled");
  }
});

test("abort and timeout close the custom dialog, clean up listeners, and release the pending guard", async () => {
  const view = ui();
  const prompts: boolean[] = [];
  view.h.pi.events.on("pi:prompt", (value: boolean) => prompts.push(value));
  const controller = new AbortController();
  const pending = view.h.call("ask_user", { question, choices: [] }, controller.signal);
  await expect(view.h.call("ask_user", { question: "Another?", choices: [] })).rejects.toThrow("pending");
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  expect(prompts).toEqual([true, false]);

  let timeout: (() => void) | undefined;
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay: number, ...args: any[]) => {
    if (delay === 600_000) timeout = fn;
    return original(fn, delay, ...args);
  }) as any);
  try {
    const timed = view.h.call("ask_user", { question: "Timed question?", choices: [] });
    expect(timeout).toBeFunction();
    timeout!();
    await expect(timed).rejects.toThrow("timed out");
    expect(prompts).toEqual([true, false, true, false]);
  } finally { timer.mockRestore(); }
});

test("the custom dialog handles setup-time aborts and removes its abort listener on completion", async () => {
  const view = ui();
  const controller = new AbortController();
  const pending = askQuestion(view.h.ctx as any, "Q?", [], controller.signal);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
  view.current().handleInput("ok");
  view.current().handleInput("\r");
  expect(await pending).toBe("ok");
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

  const aborted = new AbortController();
  const custom = view.h.ctx.ui.custom;
  view.h.ctx.ui.custom = async (...args: any[]) => { aborted.abort(); return custom(...args); };
  expect(await askQuestion(view.h.ctx as any, "Q?", [], aborted.signal)).toBeUndefined();
  expect(getEventListeners(aborted.signal, "abort")).toHaveLength(0);
});

test("RPC keeps native select/input requests and never attempts a custom TUI", async () => {
  const h = harness(); install(h.pi);
  (h.ctx as any).mode = "rpc";
  h.ctx.ui.custom = async () => { throw new Error("custom UI is not supported in RPC"); };
  h.ctx.ui.select = async (title: string, choices: string[], opts: any) => {
    expect(title).toBe(question);
    expect(choices).toEqual(["A", other]);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    return other;
  };
  h.ctx.ui.input = async (title: string, placeholder: string, opts: any) => {
    expect(title).toBe(question);
    expect(placeholder).toBe("Free-text answer");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    return "RPC answer";
  };
  expect((await h.call("ask_user", { question, choices: ["A"] })).details).toEqual({ answer: "RPC answer" });
});
