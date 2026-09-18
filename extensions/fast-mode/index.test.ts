import { expect, test } from "bun:test";
import { priorityPayload } from "./index.ts";
import install from "./index.ts";
import { harness } from "../../lib/harness.ts";
test("priority is provider gated, opt-in, and does not mutate source payload", () => {
  const payload = { model: "gpt-5.4", input: [] };
  expect(priorityPayload(payload, "openai-codex", false)).toBeUndefined();
  expect(priorityPayload(payload, "anthropic", true)).toBeUndefined();
  expect(priorityPayload(payload, "openai-codex", true)).toEqual({ ...payload, service_tier: "priority" });
  expect(payload).not.toHaveProperty("service_tier");
});
test("fast preference restores from active branch, off is always available", async () => {
  const h = harness(); install(h.pi); h.ctx.model = { provider: "openai-codex" };
  await h.command("fast", "on"); await h.emit("session_switch");
  expect((await h.emit("before_provider_request", { payload: {} }))[0]).toEqual({ service_tier: "priority" });
  h.ctx.model.provider = "anthropic";
  await expect(h.command("fast", "on")).rejects.toThrow("requires");
  await h.command("fast", "off");
  expect((await h.emit("before_provider_request", { payload: {} }))[0]).toBeUndefined();
});
