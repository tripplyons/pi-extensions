import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { viewHistory } from "../../lib/history-viewer.ts";

test("read-only viewer fits narrow widths, scrolls, resizes, refreshes themes, and strips terminal escapes", async () => {
  let component: any, action: string | undefined, renders = 0, color = "";
  const terminal = { rows: 12 };
  const ctx: any = { mode: "tui", ui: { custom: async (factory: any) => {
    component = factory({ terminal, requestRender() { renders++; } }, { fg: (_color: string, text: string) => color + text }, {}, (value: string) => { action = value; });
    return undefined;
  } } };
  await viewHistory(ctx, "History \x1b[31mtitle", Array.from({ length: 40 }, (_, i) => `Row ${i} 界 wide text`).join("\n") + "\n\x1b]52;c;payload\x07", { older: true, expand: true, more: true, entry: true });
  for (const width of [1, 5, 20, 80]) {
    component.invalidate();
    const lines = component.render(width);
    expect(lines.length).toBeLessThanOrEqual(terminal.rows);
    expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).not.toContain("\x1b]52");
  }
  const first = component.render(80).join("\n");
  component.handleInput("\x1b[6~");
  expect(component.render(80).join("\n")).not.toBe(first);
  component.handleInput("\x1b[H"); expect(component.render(80).join("\n")).toBe(first);
  terminal.rows = 6; expect(component.render(80).length).toBeLessThanOrEqual(6);
  color = "\x1b[32m"; component.invalidate(); expect(component.render(80)[0]).toContain("\x1b[32m");
  for (const [key, expected] of [["r", "refresh"], ["p", "older"], ["e", "expand"], ["n", "more"], ["o", "entry"], ["\x1b", "close"]]) {
    component.handleInput(key); expect(action).toBe(expected);
  }
  expect(renders).toBeGreaterThan(0);
});

test("viewer guards non-TUI modes before opening terminal components", async () => {
  await expect(viewHistory({ mode: "rpc" } as any, "History", "Body")).rejects.toThrow("interactive Pi");
});
