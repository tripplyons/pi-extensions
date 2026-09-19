import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import { jevEnabled } from "../../lib/jev.ts";
import { installPolicy } from "./index.ts";

test("Jev remains enabled by default and its command persists pruning preferences", async () => {
  const h = harness(); installPolicy(h.pi);
  expect(jevEnabled(h.ctx)).toBe(true);
  await h.command("jev");
  expect(h.entries).toHaveLength(0);
  await h.command("jev", "off");
  expect(jevEnabled(h.ctx)).toBe(false);
  await h.command("jev", "on");
  expect(jevEnabled(h.ctx)).toBe(true);
  await expect(h.command("jev", "invalid")).rejects.toThrow("Usage");
  expect(h.entries).toHaveLength(2);
});

test("Jev never selects reasoning effort or requests provider credentials on model rounds", async () => {
  const h = harness(); let changes = 0, authRequests = 0;
  h.ctx.model = { provider: "openai-codex", id: "gpt-6-astra", reasoning: true };
  h.pi.setThinkingLevel = () => { changes++; };
  h.ctx.modelRegistry = { getProviderAuth: async () => { authRequests++; return undefined; } };
  installPolicy(h.pi);
  for (const enabled of ["on", "off"]) {
    await h.command("jev", enabled);
    await h.emit("session_start");
    await h.emit("before_agent_start", { prompt: "Diagnose a difficult race condition" });
    for (let round = 0; round < 12; round++) await h.emit("turn_start");
    await h.emit("model_select");
    await h.emit("session_switch");
  }
  expect(changes).toBe(0);
  expect(authRequests).toBe(0);
  expect(h.pi.getThinkingLevel()).toBe("high");
});
