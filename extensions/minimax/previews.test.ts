import { expect, test } from "bun:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { harness } from "../../lib/harness.ts";
import { modeReadTool, registerTools } from "./tools.ts";

function setup(name: string, args: Record<string, unknown> = {}) {
  initTheme();
  const h = harness();
  registerTools(h.pi);
  const definition = name === "read" ? modeReadTool(process.cwd()) : h.tools.get(name)!;
  const row = new ToolExecutionComponent(name, "preview", args, {}, definition, { requestRender() {} } as any);
  const plain = (width = 100) => row.render(width).map(line => stripTerminalSequences(line).trim()).filter(Boolean).join("\n");
  return { row, plain };
}

test("MiniMax Bash previews streamed commands and expands like shell", () => {
  const { row, plain } = setup("bash");
  expect(plain()).toBe("$ ...");
  row.updateArgs({ command: "one\ntwo\nthree\nfour\nfive\nsix\nseven" });
  expect(plain()).toContain("$ one");
  expect(plain()).toContain("1 line hidden");
  row.setExpanded(true);
  expect(plain()).toContain("three\nfour\nfive");
  row.setExpanded(false);
  row.updateArgs({ command: "界".repeat(100) });
  expect(row.render(20).every(line => visibleWidth(line) <= 20)).toBe(true);
});

test("MiniMax file calls show paths and search patterns", () => {
  for (const [name, args, expected] of [
    ["read", { path: "sample.ts", offset: 2, limit: 3 }, ["sample.ts"]],
    ["write", { path: "sample.ts", content: "const preview = 1;" }, ["sample.ts"]],
    ["edit", { path: "sample.ts", edits: [{ oldText: "before", newText: "after" }] }, ["sample.ts"]],
    ["grep", { pattern: "needle", path: "src" }, ["needle", "src"]],
    ["glob", { pattern: "**/*.ts", path: "src" }, ["**/*.ts", "src"]],
  ] as const) {
    const { plain } = setup(name, args);
    for (const text of expected) expect(plain()).toContain(text);
  }
});

test("MiniMax read and search results show content rather than details metadata", () => {
  for (const name of ["read", "grep", "glob"]) {
    const { row, plain } = setup(name, { path: "sample.ts", pattern: "needle" });
    row.updateResult({ content: [{ type: "text", text: "visible result payload" }], details: {}, isError: false });
    expect(plain()).toContain("visible result payload");
    row.updateResult({ content: [{ type: "text", text: "permission denied" }], details: {}, isError: true });
    expect(plain()).toContain("permission denied");
  }
});

test("MiniMax file previews collapse and expand edit diffs without changing results", () => {
  const { row, plain } = setup("edit", { path: "sample.ts" });
  const diff = Array.from({ length: 20 }, (_, i) => `+${i + 1} changed line`).join("\n");
  const result = Object.freeze({
    content: [{ type: "text", text: "Updated sample.ts" }],
    details: Object.freeze({ diff, firstChangedLine: 1 }),
    isError: false,
  });
  row.updateResult(result);
  expect(plain()).toContain("Updated sample.ts");
  expect(plain()).toContain("+1 changed line");
  expect(plain()).toContain("Expand for more");
  expect(plain()).not.toContain("+20 changed line");
  row.setExpanded(true);
  expect(plain()).toContain("+20 changed line");
  expect(result.content).toEqual([{ type: "text", text: "Updated sample.ts" }]);
  expect(result.details.diff).toBe(diff);
});
