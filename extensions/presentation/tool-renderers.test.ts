import { expect, test } from "bun:test";
import { ToolExecutionComponent, createEditToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { compactToolRenderers, registerCompactToolRenderers } from "./tool-renderers.ts";
import { installCompactToolSpacing } from "./tool-spacing.ts";
import { harness } from "../../lib/harness.ts";

function tool(name: string, args: unknown = {}, next?: Parameters<typeof compactToolRenderers>[1]) {
  initTheme();
  return new ToolExecutionComponent(name, "test", args, {}, compactToolRenderers(name, next) as any, { requestRender() {} } as any);
}
const plain = (component: ToolExecutionComponent, width = 100) => component.render(width).map(line => stripTerminalSequences(line).trimEnd());

test("the resolver changes no tool definitions and handles tools registered later", () => {
  const h = harness();
  registerCompactToolRenderers(h.pi);
  expect(h.tools.size).toBe(0);
  expect(h.toolRenderers).toHaveLength(1);
  expect(h.toolRenderers[0]("mcp_future", () => undefined).renderCall).toBeFunction();
});

test("every collapsed tool has one content row through streaming, completion, errors and resize", () => {
  for (const name of ["read", "edit", "write", "grep", "find", "ls", "bash", "ask_user", "web_search", "swarm_spawn", "task_output", "update_plan", "mcp_future"]) {
    const component = tool(name, { path: "界".repeat(80), command: "echo first\necho second", question: "hello\nworld", query: "test" });
    for (const width of [1, 8, 30, 100]) {
      const lines = plain(component, width);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("");
      expect(visibleWidth(lines[1])).toBeLessThanOrEqual(width);
    }
    component.markExecutionStarted();
    component.updateResult({ content: [{ type: "text", text: "working\nmore" }], isError: false }, true);
    expect(plain(component)).toHaveLength(2);
    expect(plain(component).join("\n")).toContain("more");
    component.updateResult({ content: [{ type: "text", text: "finished\nmore" }], isError: false }, false);
    expect(plain(component)).toHaveLength(2);
    expect(plain(component).join("\n")).toContain("finished");
    component.updateResult({ content: [{ type: "text", text: "denied\ntrace" }], isError: true }, false);
    expect(plain(component)).toHaveLength(2);
    expect(plain(component).join("\n")).toContain("error: denied");
    component.setExpanded(true);
    expect(plain(component).join("\n")).toContain("trace");
    component.setExpanded(false);
    expect(plain(component)).toHaveLength(2);
  }
});

test("compact rows separate every execution state with one space and no decorative dot", () => {
  const component = tool("read", { path: "file.ts" });
  const check = (summary: string) => expect(plain(component)).toEqual(["", `read file.ts ${summary}`]);
  check("writing 7 chars");
  component.setArgsComplete();
  check("pending");
  component.markExecutionStarted();
  check("running");
  component.updateResult({ content: [{ type: "text", text: "started\nlatest" }], isError: false }, true);
  check("latest");
  component.updateResult({ content: [{ type: "text", text: "finished\ndetails" }], isError: false });
  check("finished");
  component.updateResult({ content: [{ type: "text", text: "denied" }], isError: true });
  check("error: denied");
});

test("removing the separator dot makes its columns available to the argument preview", () => {
  const component = tool("read", { path: "long-filename.ts" });
  component.setArgsComplete();
  expect(plain(component, 29)).toEqual(["", "read long-filename.ts pending"]);
});

test("literal dots in tool arguments and output stay unchanged", () => {
  const component = tool("read", { path: "dir.../part·one.ts" });
  component.setArgsComplete();
  component.updateResult({ content: [{ type: "text", text: "done · unchanged." }], isError: false });
  expect(plain(component)).toEqual(["", "read dir.../part·one.ts done · unchanged."]);
});

test("result truncation dots keep the result color in normal, partial, and error rows", () => {
  const ansiTheme = {
    bold: (text: string) => text,
    fg: (color: string, text: string) => `\x1b[${color === "muted" ? 90 : color === "error" ? 31 : color === "accent" ? 36 : 97}m${text}\x1b[39m`,
  } as any;
  for (const [isError, isPartial] of [[false, false], [false, true], [true, false]]) {
    const renderer = compactToolRenderers("read");
    const context = { state: {}, expanded: false, argsComplete: true, executionStarted: true, isError } as any;
    const value = { content: [{ type: "text" as const, text: "long output ".repeat(20) }] };
    renderer.renderResult!(value, { expanded: false, isPartial }, ansiTheme, context);
    const view = renderer.renderCall!({ path: "file.ts" }, ansiTheme, context);
    for (const width of [1, 4, 7, 20, 40]) {
      const row = view.render(width)[0];
      const dots = ".".repeat(Math.min(3, Math.floor(width * 0.45)));
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      if (dots) {
        expect(stripTerminalSequences(row).endsWith(dots)).toBe(true);
        expect(row).toContain(`\x1b[${isError ? 31 : 90}m${dots}`);
      }
      if (width === 40) expect(row).toContain("\x1b[97m file.ts");
    }
  }
});

test("expanded views delegate specialized renderers and preserve their state", () => {
  const component = tool("special", {}, {
    renderCall(_args, _theme, context) { context.state.owner = "special"; return new Text("special call", 0, 0); },
    renderResult(_result, _options, _theme, context) { return new Text(`${context.state.owner}\nfull output`, 0, 0); },
  });
  component.updateResult({ content: [{ type: "text", text: "summary" }], isError: false }, false);
  expect(plain(component)).toHaveLength(2);
  component.setExpanded(true);
  expect(plain(component)).toEqual(["", "special call", "special", "full output"]);
  component.setExpanded(false);
  expect(plain(component)).toHaveLength(2);
});

test("expanded edit views retain native diffs", () => {
  const native = createEditToolDefinition(process.cwd());
  const component = tool("edit", { path: "example.ts", oldText: "before", newText: "after" }, native);
  component.updateResult({ content: [{ type: "text", text: "Successfully replaced text" }], details: { diff: "-1 before\n+1 after", firstChangedLine: 1 }, isError: false }, false);
  expect(plain(component)).toHaveLength(2);
  component.setExpanded(true);
  expect(plain(component).join("\n")).toContain("before");
  expect(plain(component).join("\n")).toContain("after");
});

test("image shell adapter hides collapsed image rows and restores them when expanded", () => {
  const component = tool("image");
  // Stand-ins avoid dependence on the test terminal's image protocol support.
  const internal = component as any;
  const image = new Text("IMAGE", 0, 0);
  const spacer = new Text("", 0, 0);
  internal.imageComponents = [image];
  internal.imageSpacers = [spacer];
  component.addChild(image);
  const restore = installCompactToolSpacing();
  try {
    expect(plain(component)).toHaveLength(1);
    internal.expanded = true;
    expect(plain(component)).toContain("IMAGE");
    expect(internal.imageComponents).toEqual([image]);
  } finally { restore(); }
  internal.expanded = false;
  expect(plain(component)).toContain("IMAGE");
});
