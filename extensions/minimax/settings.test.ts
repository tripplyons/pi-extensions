import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import { compactionKey, compactionThreshold, registerThreshold } from "./settings.ts";

test("threshold preserves saved values and follows the active branch", async () => {
  const h = harness(); registerThreshold(h.pi);
  expect(compactionThreshold(h.ctx)).toBe(200000);
  h.pi.appendEntry(compactionKey, { threshold: 120000, checkpoint: { old: true } });
  expect(compactionThreshold(h.ctx)).toBe(120000);
  await h.command("threshold", "80K");
  expect(compactionThreshold(h.ctx)).toBe(80000);
  await h.command("threshold");
  expect(h.entries).toHaveLength(2);
  h.entries.pop(); expect(compactionThreshold(h.ctx)).toBe(120000);
  h.entries.length = 0; expect(compactionThreshold(h.ctx)).toBe(200000);
  for (const value of ["0", "-1", "1.5k", "oops", "999999999999999999999k"]) {
    await expect(h.command("threshold", value)).rejects.toThrow();
  }
  expect(h.entries).toHaveLength(0);
});
