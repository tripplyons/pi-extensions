import minimax from "../extensions/minimax/index.ts";
import askUser from "../extensions/ask-user/index.ts";
import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { result } from "../lib/common.ts";
import { harness } from "../lib/harness.ts";
import { previewText, renderResult } from "../lib/tool-preview.ts";
import goals from "../extensions/goal/index.ts";
import complain from "../extensions/complain/index.ts";
import swarm from "../extensions/swarm/index.ts";

const theme = { fg: (_color: string, text: string) => text } as any;
const context = { isError: false } as any;
function render(value: any, expanded = true, width = 100, isError = false) {
  return renderResult(value, { expanded, isPartial: false }, theme, { ...context, isError }).render(width).map(line => line.trimEnd());
}

test("all JSON-result tools register the text preview renderer", () => {
  const h = harness();
  for (const install of [goals, minimax, complain, swarm]) install(h.pi);
  for (const [name, tool] of h.tools) {
    if (["read", "edit", "write", "grep", "glob"].includes(name)) { expect(tool.renderResult).toBeFunction(); continue; }
    expect(tool.renderResult).toBe(renderResult);
  }
});

test("goal tools preview text while retaining structured results", async () => {
  const h = harness(); goals(h.pi);
  for (const [name, args] of [
    ["create_goal", { objective: 'Verify "all"\nresults' }],
    ["get_goal", {}],
    ["update_goal", { status: "complete" }],
  ] as const) {
    const value = await h.call(name, args);
    const output = render(value).join("\n");
    expect(output).toContain('Objective:\nVerify "all"\nresults');
    expect(output).toContain(`Status: ${value.details.status}`);
    expect(JSON.parse(value.content[0].text)).toEqual(value.details);
  }
});

test("nested records, arrays, empty values and booleans use readable text", () => {
  expect(previewText({ jobs: [{ exitCode: 0, output: "hello\nworld" }], truncated: false, skipped_files: [] }))
    .toBe("Jobs:\n- Exit code: 0\n  Output:\n  hello\n  world\nTruncated: no\nSkipped files: None");
  expect(previewText(null)).toBe("None");
  expect(previewText({})).toBe("None");
});

test("previews preserve raw JSON file contents and error text", () => {
  const payload = '{"hello":"world"}\nsecond line';
  expect(render(result({ content: payload })).join("\n")).toContain(payload);
  expect(render({ content: [{ type: "text", text: "Permission denied" }], details: { secret: "hidden" } }, true, 100, true).join("\n"))
    .toBe("Permission denied");
  expect(render({ content: [{ type: "text", text: "Working…" }] }).join("\n")).toBe("Working…");
});

test("collapsed previews bound wrapped output; expanded previews show all lines", () => {
  const value = result({ output: "界".repeat(200) });
  const collapsed = render(value, false, 20);
  expect(collapsed.length).toBeLessThanOrEqual(10);
  expect(collapsed.join("\n")).toContain("Expand for more");
  expect(render(value, true, 20).length).toBeGreaterThan(collapsed.length);
  for (const line of collapsed) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
});

test("tool names use accent, without coloring Bash commands", () => {
  const h = harness();
  for (const install of [goals, minimax, complain, swarm]) install(h.pi);
  for (const [name, tool] of h.tools) {
    const colors: [string, string][] = [];
    const theme = {
      bold: (text: string) => text,
      fg(color: string, text: string) { colors.push([color, text]); return text; },
    };
    tool.renderCall({ command: "echo hello", seconds: 30 }, theme, { state: {}, expanded: false }).render(100);
    expect(colors.filter(([color]) => color === "accent")).toEqual([["accent", name === "bash" ? "$" : name]]);
    if (name === "bash") expect(colors).toContainEqual(["text", "echo hello"]);
  }
});


test("read preview keeps streamed path and line arguments in foreground", () => {
  const h = harness(); minimax(h.pi);
  const tool = h.tools.get("read");
  for (const args of [{}, { path: "/tmp/file.ts" }, { path: "/tmp/file.ts", offset: 1, limit: 2000 }]) {
    const colors: [string, string][] = [];
    const theme = { bold: (text: string) => text, fg(color: string, text: string) { colors.push([color, text]); return text; } };
    tool.renderCall(args, theme, {}).render(100);
    expect(colors[0]).toEqual(["accent", "read"]);
    expect(colors[1]).toEqual(["text", "limit" in args ? " /tmp/file.ts (offset: 1, limit: 2000)" : "path" in args ? " /tmp/file.ts" : " ..."]);
  }
});


test("ask_user preview shows the streamed question in foreground after its accent name", () => {
  const h = harness(); askUser(h.pi);
  const tool = h.tools.get("ask_user");
  for (const question of [undefined, "Which", "Which option should I use?"]) {
    const colors: [string, string][] = [];
    const theme = { bold: (text: string) => text, fg(color: string, text: string) { colors.push([color, text]); return text; } };
    const lines = tool.renderCall({ question }, theme, {}).render(100);
    expect(colors).toEqual([["accent", "ask_user"], ["text", ` ${question ?? "..."}`]]);
    expect(lines.join("\n").trim()).toBe(`ask_user ${question ?? "..."}`);
  }
});
