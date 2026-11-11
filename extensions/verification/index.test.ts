import { expect, test } from "bun:test";
import verification, { verificationRules } from "./index.ts";
import { harness } from "../../lib/harness.ts";

test("appends the finishing rules once and keeps existing appended text", async () => {
  const h = harness(); verification(h.pi);
  const event = { systemPromptOptions: { sections: {}, promptGuidelines: [], appendSystemPrompt: "User flag text" } };
  await h.emit("before_agent_start", event);
  await h.emit("before_agent_start", event);
  expect(event.systemPromptOptions.appendSystemPrompt).toBe(`User flag text\n\n${verificationRules}`);
  const fresh: any = { systemPromptOptions: { sections: {}, promptGuidelines: [] } };
  await h.emit("before_agent_start", fresh);
  expect(fresh.systemPromptOptions.appendSystemPrompt).toBe(verificationRules);
});
