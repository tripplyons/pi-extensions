import { expect, test } from "bun:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { installCompactToolSpacing } from "./tool-spacing.ts";

test("tool shells retain one separator and preserve output spacing", () => {
  initTheme();
  const tool = new ToolExecutionComponent("example", "1", {}, {}, undefined, { requestRender() {} } as any);
  tool.updateResult({ content: [{ type: "text", text: "first\n\nlast" }], isError: false }, false);
  const plain = () => tool.render(60).map(line => stripTerminalSequences(line).trim());
  const before = plain();
  const restore = installCompactToolSpacing();
  try {
    expect(plain()).toEqual(["", "example", "", "{}", "first", "", "last"]);
    tool.setExpanded(true);
    expect(plain()).toEqual(["", "example", "", "{}", "first", "", "last"]);
  } finally { restore(); }
  expect(plain()).toEqual(before);
});

test("renderer-backed tools are compact and self-rendered shells stay unchanged", () => {
  initTheme();
  const definition = { renderCall: () => new Text("call", 0, 0), renderResult: () => new Text("result", 0, 0) };
  const tool = new ToolExecutionComponent("example", "2", {}, {}, definition as any, { requestRender() {} } as any);
  const self = new ToolExecutionComponent("example", "3", {}, {}, { ...definition, renderShell: "self" } as any, { requestRender() {} } as any);
  const before = tool.render(60);
  const selfBefore = self.render(60);
  const restore = installCompactToolSpacing();
  try {
    expect(tool.render(60).map(line => stripTerminalSequences(line).trim())).toEqual(["", "call"]);
    expect(self.render(60)).toEqual(selfBefore);
  } finally { restore(); }
  expect(tool.render(60)).toEqual(before);
});
