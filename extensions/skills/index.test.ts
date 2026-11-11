import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import install, { skillPolicy } from "./index.ts";

test("skill policy is appended once, keeps existing text, and requires reading skill instructions", async () => {
  const h = harness(); install(h.pi);
  const event: any = { systemPrompt: "Base", systemPromptOptions: { sections: {}, appendSystemPrompt: "User flag text" } };
  await h.emit("before_agent_start", event);
  await h.emit("before_agent_start", event);
  expect(event.systemPrompt).toBe("Base");
  expect(event.systemPromptOptions.sections).toEqual({});
  expect(event.systemPromptOptions.appendSystemPrompt).toBe(`User flag text\n\n${skillPolicy}`);
  expect(skillPolicy).toContain("use read to load its SKILL.md");
  expect(skillPolicy).toContain("Resolve relative paths against the skill file's directory");
  expect(skillPolicy).toContain("do not activate a skill merely because it is available");
  const fresh: any = { systemPromptOptions: { sections: {} } };
  await h.emit("before_agent_start", fresh);
  expect(fresh.systemPromptOptions.appendSystemPrompt).toBe(skillPolicy);
});

test("skill extension adds no discovery paths on startup or reload", async () => {
  const h = harness(); install(h.pi);
  for (const reason of ["startup", "reload"]) {
    expect(await h.emit("resources_discover", { cwd: h.ctx.cwd, reason })).toEqual([]);
  }
});
