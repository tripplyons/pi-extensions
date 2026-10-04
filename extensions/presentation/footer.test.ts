import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import install, { footerLine } from "./index.ts";
import { harness } from "../../lib/harness.ts";

test.each(["background: waiting", "background: preparing", "background: ready"].flatMap(background =>
  ["council", "council-openai"].map(modelId => ({ background, modelId })),
))("reserves $background behind long $modelId statuses", ({ background, modelId }) => {
  const statuses = new Map([["council", `${modelId}: round 123, Sol 8/8`], ["goal", "long goal status".repeat(10)], ["background-compaction", background]]);
  for (const width of [30, 60, 80, 120]) {
    const line = footerLine(["folder".repeat(30), "council", "25%/272k", "$1.23"], statuses, "\x1b[2m | \x1b[0m", width);
    expect(line).toContain(background);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test("footer handles narrow terminals, ANSI colors, and wide characters", () => {
  const statuses = new Map([["background-compaction", "background: ready"]]);
  for (const width of [0, 1, 2, 10, 18, 25, 80]) {
    const line = footerLine(["\x1b[32m宽目录\x1b[0m", "council"], statuses, " | ", width);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test.each(["council", "council-openai"])("%s hides selected effort without hiding it for other models", async modelId => {
  const h = harness();
  let footer: any;
  Object.assign(h.ctx.ui, {
    setToolsExpanded() {}, setTitle() {}, setWorkingVisible() {}, setWorkingIndicator() {},
    setFooter(factory: any) {
      footer = factory?.({}, { fg: (_color: string, text: string) => text }, {
        getExtensionStatuses: () => new Map([["background-compaction", "background: waiting"]]),
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
