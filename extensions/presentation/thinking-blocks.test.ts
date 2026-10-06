import { expect, test } from "bun:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { installHiddenThinkingBlocks } from "./thinking-blocks.ts";

const thinking = (text = "private reasoning") => ({ type: "thinking", thinking: text });
const prose = (text = "answer") => ({ type: "text", text });
const toolCall = { type: "toolCall", id: "call", name: "read", arguments: {} };
const message = (content: unknown[], extra = {}) => ({ role: "assistant", content, stopReason: "stop", ...extra }) as any;
const plain = (component: AssistantMessageComponent) => component.render(60).map(line => stripTerminalSequences(line).trimEnd());

function component(content: unknown[], hidden = true, extra = {}) {
  initTheme();
  return new AssistantMessageComponent(message(content, extra), hidden);
}

test("hidden thinking-only messages and tool preambles render no rows", () => {
  const only = component([thinking()]);
  const tools = component([thinking(), toolCall]);
  const before = plain(only);
  expect(before.join("\n")).toContain("Thinking...");
  const restore = installHiddenThinkingBlocks();
  try {
    expect(plain(only)).toEqual([]);
    expect(plain(tools)).toEqual([]);
    only.updateContent(message([thinking("streamed reasoning")]));
    expect(plain(only)).toEqual([]);
    only.setHiddenThinkingLabel("Custom thinking marker");
    expect(plain(only)).toEqual([]);
    only.invalidate();
    expect(plain(only)).toEqual([]);
  } finally { restore(); }
  expect(plain(only).join("\n")).toContain("Custom thinking marker");
  expect(plain(tools).join("\n")).toContain("Thinking...");
});

test("hidden runs add no spacing to prose or change session messages", () => {
  const baseline = component([prose("first\n\nlast")]);
  const expected = plain(baseline);
  const contents = [
    [thinking(), prose("first\n\nlast")],
    [prose("first\n\nlast"), thinking()],
    [thinking(), prose("first\n\nlast"), thinking()],
    [thinking(), thinking("second run"), prose("first\n\nlast")],
  ];
  const restore = installHiddenThinkingBlocks();
  try {
    for (const content of contents) {
      const input = message(content);
      const snapshot = JSON.stringify(input);
      const view = new AssistantMessageComponent(input, true);
      expect(plain(view)).toEqual(expected);
      view.invalidate();
      expect(plain(view)).toEqual(expected);
      expect(JSON.stringify(input)).toBe(snapshot);
    }
  } finally { restore(); }
});

test("visible thinking and visibility changes retain native rendering", () => {
  const content = [thinking(), prose()];
  const view = component(content, false);
  const visible = plain(view);
  const restore = installHiddenThinkingBlocks();
  try {
    expect(plain(view)).toEqual(visible);
    view.setHideThinkingBlock(true);
    expect(plain(view)).toEqual(plain(component([prose()])));
    view.setHideThinkingBlock(false);
    expect(plain(view)).toEqual(visible);
  } finally { restore(); }
});

test("length, error and abort notices survive hidden thinking removal", () => {
  const restore = installHiddenThinkingBlocks();
  try {
    for (const stopReason of ["length", "error", "aborted"]) {
      const extra = { stopReason, errorMessage: "failure detail" };
      const expected = plain(component([], true, extra));
      expect(plain(component([thinking()], true, extra))).toEqual(expected);
    }
  } finally { restore(); }
});

test("per-run mouse visibility overrides remain aligned after hiding a run", () => {
  const view = component([thinking("first reasoning"), prose("middle"), thinking("last reasoning")], false);
  const restore = installHiddenThinkingBlocks();
  try {
    const rows = plain(view);
    expect(rows.join("\n")).toContain("first reasoning");
    expect(view.handleMouse({ type: "click", button: "left", x: 1, y: 1,
      screenX: 1, screenY: 1, width: 60, height: rows.length,
      shift: false, alt: false, ctrl: false })?.handled).toBe(true);
    const compact = plain(view);
    expect(compact.join("\n")).not.toContain("first reasoning");
    expect(compact.join("\n")).not.toContain("Thinking...");
    expect(compact.join("\n")).toContain("last reasoning");
    expect(view.handleMouse({ type: "click", button: "left", x: 1, y: compact.findIndex(row => row.includes("last reasoning")),
      screenX: 1, screenY: 1, width: 60, height: compact.length,
      shift: false, alt: false, ctrl: false })?.handled).toBe(true);
    expect(plain(view)).toEqual(plain(component([prose("middle")])));
  } finally { restore(); }
});
