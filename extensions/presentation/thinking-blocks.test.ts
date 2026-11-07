import { expect, test } from "bun:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { installCompactThinkingBlocks, latestThinkingLine } from "./thinking-blocks.ts";

const thinking = (text = "private reasoning") => ({ type: "thinking", thinking: text });
const prose = (text = "answer") => ({ type: "text", text });
const toolCall = { type: "toolCall", id: "call", name: "read", arguments: {} };
const message = (content: unknown[], extra = {}) => ({ role: "assistant", content, stopReason: "stop", ...extra }) as any;
const plain = (component: AssistantMessageComponent, width = 60) => component.render(width).map(line => stripTerminalSequences(line).trimEnd());
const click = (view: AssistantMessageComponent, text: string) => {
  const rows = plain(view);
  return view.handleMouse({ type: "click", button: "left", x: 1, y: rows.findIndex(row => row.includes(text)),
    screenX: 1, screenY: 1, width: 60, height: rows.length, shift: false, alt: false, ctrl: false })?.handled;
};
type Expandable = AssistantMessageComponent & { setExpanded(expanded: boolean): void };

function component(content: unknown[], hidden = true, extra = {}) {
  initTheme();
  return new AssistantMessageComponent(message(content, extra), hidden);
}

test("latest thinking line skips blank lines and common Markdown markers", () => {
  expect(latestThinkingLine("first\n\n## **Plan**  next\n\n")).toBe("Plan next");
  expect(latestThinkingLine("one\ntwo   words\n  ")).toBe("two words");
  expect(latestThinkingLine("\x1b[31mred\x1b[0m")).toBe("red");
  expect(latestThinkingLine("  \n")).toBe("");
});

test("collapsed thinking shows its latest line on one row whatever hideThinkingBlock says", () => {
  const content = [thinking("first idea\n\nsecond idea"), prose()];
  const native = component([thinking("x"), prose()], true);
  const before = plain(native);
  expect(before.join("\n")).toContain("Thinking...");
  const restore = installCompactThinkingBlocks();
  try {
    for (const hidden of [true, false]) {
      const view = component(content, hidden);
      expect(plain(view)).toEqual(["", " second idea", "", " answer"]);
      view.setHideThinkingBlock(!hidden);
      expect(plain(view)).toEqual(["", " second idea", "", " answer"]);
    }
    expect(plain(component([thinking("only")]))).toEqual(["", " only"]);
    expect(plain(component([thinking("before tool"), toolCall]))).toEqual(["", " before tool"]);
  } finally { restore(); }
  expect(plain(native)).toEqual(before);
});

test("long lines truncate to the terminal width instead of wrapping", () => {
  const restore = installCompactThinkingBlocks();
  try {
    const view = component([thinking(`start ${"word ".repeat(40)}end`)]);
    const rows = view.render(40);
    expect(rows).toHaveLength(2);
    expect(stripTerminalSequences(rows[1]).length).toBeLessThanOrEqual(40);
    expect(stripTerminalSequences(rows[1]).trimEnd().endsWith("...")).toBe(true);
    expect(plain(view, 1)).toHaveLength(2);
  } finally { restore(); }
});

test("streaming updates show the newest line and leave session messages unchanged", () => {
  const restore = installCompactThinkingBlocks();
  try {
    const block = thinking("step one");
    const input = message([block]);
    const snapshot = () => JSON.stringify(input);
    const view = component([]);
    view.updateContent(input, true);
    expect(plain(view)).toEqual(["", " step one"]);
    block.thinking += "\nstep two";
    const before = snapshot();
    view.updateContent(input, true);
    expect(plain(view)).toEqual(["", " step two"]);
    view.invalidate();
    expect(plain(view)).toEqual(["", " step two"]);
    expect(snapshot()).toBe(before);
  } finally { restore(); }
});

test("expansion shows full native thinking and applies to new messages", () => {
  const content = [prose("Opening"), thinking("first line\nsecond line"), prose("Closing")];
  const full = plain(component(content, false));
  const restore = installCompactThinkingBlocks();
  try {
    const view = component(content) as Expandable;
    expect(plain(view)).toEqual(["", " Opening", " second line", "", " Closing"]);
    view.setExpanded(true);
    expect(plain(view)).toEqual(full);
    expect(plain(component(content))).toEqual(full);
    view.setExpanded(false);
    expect(plain(view)).toEqual(["", " Opening", " second line", "", " Closing"]);
    expect(plain(component(content))).toEqual(["", " Opening", " second line", "", " Closing"]);
  } finally { restore(); }
  expect(Object.prototype.hasOwnProperty.call(AssistantMessageComponent.prototype, "setExpanded")).toBe(false);
});

test("clicking a run toggles only that run until the next global change", () => {
  const view = component([thinking("first a\nfirst b"), prose("middle"), thinking("last a\nlast b")]) as Expandable;
  const restore = installCompactThinkingBlocks();
  try {
    expect(plain(view)).toEqual(["", " first b", "", " middle", " last b"]);
    expect(click(view, "first b")).toBe(true);
    expect(plain(view)).toEqual(["", " first a", " first b", "", " middle", " last b"]);
    expect(click(view, "last b")).toBe(true);
    expect(plain(view)).toEqual(["", " first a", " first b", "", " middle", " last a", " last b"]);
    expect(click(view, "first a")).toBe(true);
    expect(plain(view)).toEqual(["", " first b", "", " middle", " last a", " last b"]);
    view.setExpanded(false);
    expect(plain(view)).toEqual(["", " first b", "", " middle", " last b"]);
    view.setExpanded(true);
    expect(click(view, "last a")).toBe(true);
    expect(plain(view)).toEqual(["", " first a", " first b", "", " middle", " last b"]);
  } finally { restore(); }
});

test("length, error and abort notices follow compact thinking", () => {
  const restore = installCompactThinkingBlocks();
  try {
    for (const stopReason of ["length", "error", "aborted"]) {
      const extra = { stopReason, errorMessage: "failure detail" };
      const notice = plain(component([], true, extra));
      expect(plain(component([thinking()], true, extra))).toEqual(["", " private reasoning", ...notice]);
    }
  } finally { restore(); }
});

test("removal restores native thinking markers on adapted components", () => {
  const view = component([thinking(), prose()]);
  const native = plain(view);
  const restore = installCompactThinkingBlocks();
  expect(plain(view)).toEqual(["", " private reasoning", "", " answer"]);
  restore();
  expect(plain(view)).toEqual(native);
});

test("rows and truncation dots use the current theme's thinking style", () => {
  let color = 31;
  const theme = { italic: (text: string) => `\x1b[3m${text}\x1b[23m`, fg: (name: string, text: string) => name === "thinkingText" ? `\x1b[${color}m${text}\x1b[39m` : text } as any;
  const restore = installCompactThinkingBlocks(() => theme);
  try {
    const view = component([thinking("short")]);
    expect(view.render(60)[1]).toContain("\x1b[3m\x1b[31mshort");
    color = 32;
    view.invalidate();
    expect(view.render(60)[1]).toContain("\x1b[3m\x1b[32mshort");
    const long = component([thinking("word ".repeat(30))]).render(20)[1];
    expect(stripTerminalSequences(long)).toEndWith("...");
    expect(long).toContain("\x1b[3m\x1b[32m...");
  } finally { restore(); }
});
