import { expect, test } from "bun:test";
import { UserMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { compactUserRows, installCompactUserMessages } from "./user-messages.ts";

test("user messages drop vertical padding, preserve zones, and restore on shutdown", () => {
  initTheme();
  const message = new UserMessageComponent("hello", getMarkdownTheme(), 0);
  const original = message.render(40);
  expect(original).toHaveLength(3);
  const restore = installCompactUserMessages();
  try {
    const lines = message.render(40);
    expect(lines).toHaveLength(1);
    expect(stripTerminalSequences(lines[0]).trim()).toBe("hello");
    for (const marker of ["A", "B", "C"]) expect(lines[0]).toContain(`\x1b]133;${marker}\x07`);
  } finally { restore(); }
  expect(message.render(40)).toEqual(original);
});

test("unexpected layouts are unchanged and intentional content spacing survives", () => {
  expect(compactUserRows(["content"])).toEqual(["content"]);
  expect(compactUserRows(["first", "", "last"])).toEqual(["first", "", "last"]);
  expect(compactUserRows(["", "first", "", "last", ""])).toEqual(["first", "", "last"]);
});
