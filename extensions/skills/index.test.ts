import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";

test("skill policy preserves the base prompt and requires reading skill instructions", async () => {
  const h = harness(); install(h.pi);
  const [policy] = await h.emit("before_agent_start", { systemPrompt: "Base" });
  expect(policy.systemPrompt).toStartWith("Base\n");
  expect(policy.systemPrompt).toContain("use read to load its SKILL.md");
  expect(policy.systemPrompt).toContain("Resolve relative paths against the skill file's directory");
  expect(policy.systemPrompt).toContain("do not activate a skill merely because it is available");
});

test("skill extension adds no discovery paths on startup or reload", async () => {
  const h = harness(); install(h.pi);
  for (const reason of ["startup", "reload"]) {
    expect(await h.emit("resources_discover", { cwd: h.ctx.cwd, reason })).toEqual([]);
  }
});
