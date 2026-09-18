import { test, expect } from "bun:test";
import install from "./index.ts";
import { harness } from "../../lib/harness.ts";

test("models select exact authenticated IDs without shadowing Pi's picker", async () => {
  const h = harness(); install(h.pi);
  const model = { provider: "test", id: "a" };
  h.ctx.modelRegistry = { getAvailable: () => [model] };
  let selected;
  h.pi.setModel = async (value: unknown) => { selected = value; return true; };
  await h.command("models", "test/a");
  expect(selected).toBe(model);
  expect(h.commands.has("model")).toBe(false);
  await expect(h.command("models", "a")).rejects.toThrow("Unavailable");
  h.pi.setModel = async () => false;
  await expect(h.command("models", "test/a")).rejects.toThrow("authentication");
});
test("reasoning aliases reject unsupported levels before changing state", async () => {
  const h = harness(); install(h.pi);
  h.ctx.model = { id: "simple", provider: "test", reasoning: false };
  let effort = "off";
  h.pi.setThinkingLevel = (level: string) => { effort = level; };
  h.pi.getThinkingLevel = () => effort;
  for (const name of ["reasoning", "thinking", "effort"]) {
    await h.command(name, "off");
    await expect(h.command(name, "xhigh")).rejects.toThrow("Unsupported");
    expect(effort).toBe("off");
  }
});
