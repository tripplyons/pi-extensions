import { expect, test } from "bun:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderCall } from "./command-preview.ts";
import install from "./index.ts";
import { harness } from "../../lib/harness.ts";

function setup() {
  initTheme();
  const h = harness();
  install(h.pi);
  const definition = h.tools.get("bash");
  const row = new ToolExecutionComponent("bash", "test", {}, {}, definition, { requestRender() {} } as any);
  const plain = (width = 100) => row.render(width).map(line => stripTerminalSequences(line).trim()).filter(Boolean);
  return { row, plain, definition: definition! };
}

test("collapsed Bash follows streamed arguments and expansion without mutating the command", () => {
  const { row, plain } = setup();
  expect(plain()).toEqual(["$ ..."]);
  for (let count = 1; count <= 10; count++) {
    const lines = Array.from({ length: count }, (_, i) => `line ${i + 1}`);
    const args = Object.freeze({ command: lines.join("\n"), timeout: 12 });
    row.updateArgs(args);
    const expected = count > 6 ? [...lines.slice(0, 3), `... (${count - 6} ${count === 7 ? "line" : "lines"} hidden)`, ...lines.slice(-3)] : [...lines];
    expected[0] = `$ ${expected[0]}`;
    expect(plain()).toEqual(expected);
    expect(args.command).toBe(lines.join("\n"));
  }
  row.updateArgs({ command: "1\n2\n3\n4\n5\n6\npar" });
  expect(plain()).toEqual(["$ 1", "2", "3", "... (1 line hidden)", "5", "6", "par"]);
  row.updateArgs({ command: "1\n2\n3\n4\n5\n6\npartial\nnext" });
  row.setArgsComplete();
  expect(plain()).toEqual(["$ 1", "2", "3", "... (2 lines hidden)", "6", "partial", "next"]);
  row.setExpanded(true);
  expect(plain()).toEqual(["$ 1", "2", "3", "4", "5", "6", "partial", "next"]);
  row.setExpanded(false);
  row.updateArgs({ command: "short" });
  expect(plain()).toEqual(["$ short"]);
});

test("collapsed command lines clip at terminal width and resize without wrapping", () => {
  const { row, plain } = setup();
  row.updateArgs({ command: "界".repeat(80) + "\n" + "x".repeat(100) });
  for (const width of [20, 40, 10, 100]) {
    expect(plain(width)).toHaveLength(2);
    expect(row.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
  }
  row.setExpanded(true);
  expect(plain(20).length).toBeGreaterThan(2);
});


test("collapsed hidden-line marker uses the dim theme color", () => {
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
  const component = renderCall({ command: "1\n2\n3\n4\n5\n6\n7" }, theme as any, { expanded: false } as any);
  expect(component.render(100)[3]).toBe("<dim>... (1 line hidden)</dim>");
});
