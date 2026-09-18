import { expect, test } from "bun:test";
import { tokens, usage } from "./index.ts";
import { harness } from "../../lib/harness.ts";
test("footer formats tokens and accounts only for the active branch", () => {
 expect([12, 1500, 25000, 2500000].map(tokens)).toEqual(["12", "1.5k", "25k", "2.5M"]);
 const h = harness();
 h.entries.push({ type: "message", message: { role: "assistant", usage: { input: 10, cacheRead: 30, cacheWrite: 5, output: 7, cost: { total: 0.02 } } } });
 expect(usage(h.ctx)).toEqual({ cost: 0.02, last: { input: 45, output: 7 } });
 h.entries.length = 0; expect(usage(h.ctx)).toEqual({ cost: 0, last: undefined });
});
