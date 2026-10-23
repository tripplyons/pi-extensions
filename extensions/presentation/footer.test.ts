import { expect, spyOn, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import install, { footerLine, modelFamily } from "./index.ts";
import { harness } from "../../lib/harness.ts";
import { registerCouncils } from "../council/index.ts";
import { fixtureCouncils } from "../council/fixtures.ts";

test("spinner animates agent and branch-scoped background work and cleans up its lifecycle", async () => {
  const h = harness();
  let footer: any;
  let renders = 0;
  const ticks: Array<() => void> = [];
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((tick: () => void, ms: number) => {
    expect(ms).toBe(150);
    ticks.push(tick);
    return { unref() {} };
  }) as any);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  const snapshot = (tasks: unknown[], sessionFile = "/test/session.jsonl", source = "tasks") =>
    h.pi.events.emit("t3:background-tasks", { sessionFile, source, tasks });
  Object.assign(h.ctx.ui, {
    setToolsExpanded() {}, setTitle() {}, setWorkingVisible() {}, setWorkingIndicator() {},
    setFooter(factory: any) {
      footer?.dispose?.();
      footer = factory?.({ requestRender() { renders++; } }, { fg: (_: string, text: string) => text }, {
        getExtensionStatuses: () => new Map(),
      });
    },
  });
  install(h.pi);
  try {
    await h.emit("session_start");
    const idle = footer.render(120)[0];
    expect(ticks).toHaveLength(0);
    snapshot([{}], "/other/session.jsonl");
    expect(footer.render(120)[0]).toBe(idle);
    await h.emit("agent_start");
    expect(ticks).toHaveLength(1);
    for (const frame of ["[/]", "[-]", "[\\]", "[|]", "[/]"]) {
      expect(footer.render(120)[0]).toBe(`${frame} ${idle}`);
      ticks[0]();
    }
    expect(renders).toBeGreaterThan(4);
    for (const width of [0, 1, 3, 4, 10, 40, 120]) {
      expect(visibleWidth(footer.render(width)[0])).toBeLessThanOrEqual(width);
    }
    snapshot([{}]);
    await h.emit("agent_end");
    expect(footer.render(120)[0]).toStartWith("[-] ");
    snapshot([], "/other/session.jsonl");
    expect(footer.render(120)[0]).toStartWith("[-] ");
    snapshot([{}], "/test/session.jsonl", "other-source");
    snapshot([]);
    expect(footer.render(120)[0]).toStartWith("[-] ");
    snapshot([], "/test/session.jsonl", "other-source");
    expect(footer.render(120)[0]).toBe(idle);
    expect(clear).toHaveBeenCalledTimes(1);
    snapshot([{}]);
    expect(ticks).toHaveLength(2);
    await h.emit("session_tree");
    expect(footer.render(120)[0]).toBe(idle);
    // A producer answers snapshot requests, including after reload/session switch.
    const detach = h.pi.events.on("t3:background-tasks-request", () => snapshot([{}]));
    await h.emit("session_start");
    expect(footer.render(120)[0]).toStartWith("[/] ");
    detach();
    await h.emit("session_shutdown");
    const previousRenders = renders;
    snapshot([{}]);
    await h.emit("agent_start");
    expect(renders).toBe(previousRenders);
    expect(footer).toBeUndefined();
  } finally {
    await h.emit("session_shutdown");
    timers.mockRestore();
    clear.mockRestore();
  }
});

test.each(["council", "council-openai"])("fits long %s statuses in the footer width", modelId => {
  const statuses = new Map([["council", `${modelId}: round 123, Sol 8/8`], ["goal", "long goal status".repeat(10)]]);
  for (const width of [30, 60, 80, 120]) {
    const line = footerLine(["folder".repeat(30), "council", "25%/272k", "$1.23"], statuses, "\x1b[2m | \x1b[0m", width);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test("footer handles narrow terminals, ANSI colors, and wide characters", () => {
  const statuses = new Map([["goal", "goal: active"]]);
  for (const width of [0, 1, 2, 10, 18, 25, 80]) {
    const line = footerLine(["\x1b[32m宽目录\x1b[0m", "council"], statuses, " | ", width);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test.each(["council", "council-openai"])("%s hides selected effort without hiding it for other models", async modelId => {
  const h = harness();
  registerCouncils({ registerVirtualModel() {}, on() {} } as any, fixtureCouncils);
  let footer: any;
  Object.assign(h.ctx.ui, {
    setToolsExpanded() {}, setTitle() {}, setWorkingVisible() {}, setWorkingIndicator() {},
    setFooter(factory: any) {
      footer = factory?.({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {
        getExtensionStatuses: () => new Map([["goal", "goal: active"]]),
      });
    },
  });
  install(h.pi);
  h.ctx.model = { provider: "tripp", id: modelId };
  h.pi.getThinkingLevel = () => "medium";
  await h.emit("session_start");
  expect(footer.render(200)).toHaveLength(1);
  expect(footer.render(200)[0]).toContain(modelId);
  expect(footer.render(200)[0]).not.toContain("medium");
  h.ctx.model = { provider: "openai", id: "gpt-6.1-sol" };
  expect(footer.render(200)[0]).toContain("medium");
  h.ctx.model = { provider: "other", id: "council" };
  expect(footer.render(200)[0]).toContain("medium");
});

test.each([
  ["claude-opus-5-5", "opus"], ["claude-haiku-4-5-20251001", "haiku"], ["claude-fable-5-1", "fable"],
  ["gpt-6.1-sol", "sol"], ["deepseek/deepseek-v4.1-flash-1017", "deepseek-flash"],
  ["council-openai", "council-openai"], ["kimi-k3", "kimi"], ["o3", "o3"],
])("model family of %s is %s", (id, family) => expect(modelFamily(id)).toBe(family));

test("footer shows effort and fast mode in parentheses after the model family", async () => {
  const h = harness();
  registerCouncils({ registerVirtualModel() {}, on() {} } as any, fixtureCouncils);
  let footer: any;
  const statuses = new Map([["fast", "fast"], ["goal", "goal: active"]]);
  Object.assign(h.ctx.ui, {
    setToolsExpanded() {}, setTitle() {}, setWorkingVisible() {}, setWorkingIndicator() {},
    setFooter(factory: any) { footer = factory?.({ requestRender() {} }, { fg: (_color: string, text: string) => text }, { getExtensionStatuses: () => statuses }); },
  });
  install(h.pi);
  h.ctx.model = { provider: "claude-bridge", id: "claude-opus-5-5" };
  h.pi.getThinkingLevel = () => "medium";
  await h.emit("session_start");
  const fields = () => footer.render(200)[0].split(" | ");
  expect(fields()[1]).toBe("opus (medium, fast)");
  expect(fields().at(-1)).toBe("goal: active");
  expect(fields()).not.toContain("fast");
  statuses.delete("fast");
  expect(fields()[1]).toBe("opus (medium)");
  h.ctx.model = { provider: "tripp", id: "council" };
  expect(fields()[1]).toBe("council");
  statuses.set("fast", "fast");
  expect(fields()[1]).toBe("council (fast)");
});
