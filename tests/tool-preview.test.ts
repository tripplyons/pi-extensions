import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { result } from "../lib/common.ts";
import { harness } from "../lib/harness.ts";
import { previewText, renderResult } from "../lib/tool-preview.ts";
import goals from "../extensions/goal/index.ts";
import files from "../extensions/files/index.ts";
import shell from "../extensions/shell/index.ts";
import complain from "../extensions/complain/index.ts";
import pruner from "../extensions/context-pruner/index.ts";
import swarm from "../extensions/swarm/index.ts";

const theme = { fg: (_color: string, text: string) => text } as any;
const context = { isError: false } as any;
function render(value: any, expanded = true, width = 100, isError = false) {
  return renderResult(value, { expanded, isPartial: false }, theme, { ...context, isError }).render(width).map(line => line.trimEnd());
}

test("all JSON-result tools register the text preview renderer", () => {
  const h = harness();
  for (const install of [goals, files, shell, complain, pruner, swarm]) install(h.pi);
  for (const [name, tool] of h.tools) {
    if (name === "view_image") continue;
    expect(tool.renderResult).toBe(renderResult);
  }
  expect(h.tools.get("view_image").renderResult).toBeUndefined();
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
