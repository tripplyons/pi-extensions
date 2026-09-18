import { expect, test } from "bun:test";
import install, { tokens, usage } from "./index.ts";
import { harness } from "../../lib/harness.ts";
test("footer formats tokens and accounts only for the active branch", () => {
 expect([12, 1500, 25000, 2500000].map(tokens)).toEqual(["12", "1.5k", "25k", "2.5M"]);
 const h = harness();
 h.entries.push({ type: "message", message: { role: "assistant", usage: { input: 10, cacheRead: 30, cacheWrite: 5, output: 7, cost: { total: 0.02 } } } });
 expect(usage(h.ctx)).toEqual({ cost: 0.02, last: { input: 45, output: 7 } });
 h.entries.length = 0; expect(usage(h.ctx)).toEqual({ cost: 0, last: undefined });
});

test("hides the working indicator and keeps the footer unchanged while busy", async () => {
  const h = harness();
  const indicators: unknown[] = [];
  let footer: any;
  h.ctx.ui.setToolsExpanded = () => {};
  h.ctx.ui.setTitle = () => {};
  h.ctx.ui.setWorkingIndicator = (options: unknown) => indicators.push(options);
  h.ctx.ui.setFooter = (factory: any) => {
    footer = factory?.({}, { fg: (_color: string, text: string) => text }, {
      getExtensionStatuses: () => new Map(),
    });
  };
  install(h.pi);
  await h.emit("session_start");
  expect(indicators).toEqual([{ frames: [] }]);
  const idle = footer.render(120);
  await h.emit("agent_start");
  expect(footer.render(120)).toEqual(idle);
  expect(footer.render(120).join("\n")).not.toContain("[*]");
  await h.emit("agent_end");
  await h.emit("session_switch");
  expect(indicators).toEqual([{ frames: [] }, { frames: [] }]);
  await h.emit("session_shutdown");
  expect(indicators.at(-1)).toBeUndefined();
  expect(footer).toBeUndefined();
});
