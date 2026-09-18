import { expect, test } from "bun:test";
import { Glow } from "./index.ts";
test("OSC glow is TTY gated, deduplicated, prompt-prioritized and reset", () => {
  const output: string[] = []; const glow = new Glow(value => output.push(value));
  glow.show(); expect(output).toHaveLength(0);
  glow.active = true; glow.show(); glow.show(); expect(output).toHaveLength(1);
  glow.busy = true; glow.show(); expect(output.at(-1)).toContain("e5c07b;hold");
  glow.prompt = true; glow.show(); expect(output.at(-1)).toContain("61afef;hold");
  glow.prompt = false; glow.busy = false; glow.attention = true; glow.show();
  glow.reset(); expect(output.at(-1)).toBe("\x1b]777;overseer;glow;off\x07");
  expect(() => new Glow(() => {}, "bad\x07")).toThrow();
});
