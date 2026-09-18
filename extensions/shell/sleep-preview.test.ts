import { expect, test } from "bun:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";

function setup() {
  initTheme();
  const h = harness();
  install(h.pi);
  const tool = h.tools.get("sleep");
  const row = new ToolExecutionComponent("sleep", "test", {}, {}, tool, { requestRender() {} } as any);
  const text = () => row.render(100).map(stripTerminalSequences).join("\n");
  return { h, tool, row, text };
}

test("sleep preview shows streamed duration, live remaining time and completion", async () => {
  const { h, tool, row, text } = setup();
  expect(text()).toContain("sleep ...");
  row.updateArgs({ seconds: 0.4 });
  expect(text()).toContain("sleep 0.4s");
  expect(text()).not.toContain("remaining");
  const remaining: number[] = [];
  const result = await tool.execute("test", { seconds: 0.4 }, undefined, (update: any) => {
    remaining.push(update.details.remaining);
    row.updateResult({ ...update, isError: false }, true);
    expect(text()).toContain(`sleep 0.4s - ${Math.ceil(update.details.remaining)}s remaining`);
  }, h.ctx);
  expect(remaining.length).toBeGreaterThan(2);
  expect(remaining.at(-1)!).toBeLessThan(remaining[0]);
  row.updateResult({ ...result, isError: false }, false);
  expect(text()).toContain("sleep 0.4s");
  expect(text()).not.toContain("remaining");
  expect(text()).toContain("timeout");
});

test("sleep countdown clears on early wake and cancellation", async () => {
  for (const abort of [false, true]) {
    const { h, tool, row, text } = setup();
    const controller = new AbortController();
    row.updateArgs({ seconds: 10 });
    h.ctx.hasPendingMessages = () => !abort;
    try {
      const result = await tool.execute("test", { seconds: 10 }, controller.signal, (update: any) => {
        row.updateResult({ ...update, isError: false }, true);
        expect(text()).toContain("remaining");
        if (abort) controller.abort();
      }, h.ctx);
      expect(result.details.reason).toBe("activity");
      row.updateResult({ ...result, isError: false }, false);
    } catch (error) {
      expect(abort).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      row.updateResult({ content: [{ type: "text", text: String(error) }], isError: true }, false);
    }
    expect(text()).not.toContain("remaining");
  }
});
