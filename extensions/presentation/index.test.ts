import { expect, test } from "bun:test";
import install, { tokens, usage } from "./index.ts";
import { harness } from "../../lib/harness.ts";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { compactToolRenderers } from "./tool-renderers.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
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
  const visibility: unknown[] = [];
  let footer: any;
  h.ctx.ui.setToolsExpanded = () => {};
  h.ctx.ui.setTitle = () => {};
  h.ctx.ui.setWorkingVisible = (message: unknown) => visibility.push(message);
  h.ctx.ui.setWorkingIndicator = (options: unknown) => indicators.push(options);
  h.ctx.ui.setFooter = (factory: any) => {
    footer = factory?.({}, { fg: (_color: string, text: string) => text }, {
      getExtensionStatuses: () => new Map(),
    });
  };
  install(h.pi);
  await h.emit("session_start");
  expect(indicators).toEqual([{ frames: [] }]);
  expect(visibility).toEqual([false]);
  const idle = footer.render(120);
  await h.emit("agent_start");
  expect(footer.render(120)).toEqual(idle);
  expect(footer.render(120).join("\n")).not.toContain("[*]");
  await h.emit("agent_end");
  await h.emit("session_start", { reason: "resume" });
  expect(indicators).toEqual([{ frames: [] }, { frames: [] }]);
  await h.emit("session_shutdown");
  expect(indicators.at(-1)).toBeUndefined();
  expect(footer).toBeUndefined();
  expect(visibility).toEqual([false, false, true]);
});

test("TUI lifecycle removes tool separators and hidden thinking markers, then restores native rendering", async () => {
  initTheme();
  const h = harness();
  h.ctx.mode = "tui";
  Object.assign(h.ctx.ui, {
    setToolsExpanded() {}, setTitle() {}, setWorkingVisible() {}, setWorkingIndicator() {}, setFooter() {},
  });
  const thinking = new AssistantMessageComponent({ role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }], stopReason: "stop" } as any, true);
  const tool = new ToolExecutionComponent("read", "call", { path: "file.ts" }, {}, compactToolRenderers("read") as any, { requestRender() {} } as any);
  const original = thinking.render(60).map(stripTerminalSequences);
  install(h.pi);
  try {
    await h.emit("session_start");
    expect(thinking.render(60)).toEqual([]);
    expect(tool.render(60)).toHaveLength(1);
    await h.emit("session_start", { reason: "resume" });
    expect(thinking.render(60)).toEqual([]);
    expect(tool.render(60)).toHaveLength(1);
  } finally { await h.emit("session_shutdown"); }
  expect(thinking.render(60).map(stripTerminalSequences)).toEqual(original);
  expect(tool.render(60)).toHaveLength(2);
});

test("context footer uses Pi's native context window and handles unknown post-compaction usage", async () => {
  const h = harness();
  h.ctx.model = { contextWindow: 1_050_000 };
  let context: any = { percent: 25, tokens: 262_500, contextWindow: 1_050_000 };
  h.ctx.getContextUsage = () => context;
  let footer: any;
  Object.assign(h.ctx.ui, {
    setToolsExpanded() {}, setTitle() {}, setWorkingVisible() {}, setWorkingIndicator() {},
    setFooter(factory: any) {
      footer = factory?.({}, { fg: (_color: string, text: string) => text }, {
        getExtensionStatuses: () => new Map(),
      });
    },
  });
  install(h.pi);
  await h.emit("session_start");
  expect(footer.render(200)[0]).toContain("25%/1.1M");
  context = { percent: null, tokens: null, contextWindow: 1_050_000 };
  expect(footer.render(200)[0]).toContain("?%/1.1M");
  context = undefined;
  h.ctx.model = { contextWindow: 200_000 };
  expect(footer.render(200)[0]).toContain("?%/200k");
});
