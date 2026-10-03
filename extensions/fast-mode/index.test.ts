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
  await h.command("fast", "on"); await h.emit("session_start", { reason: "resume" });
  expect((await h.emit("before_provider_request", { payload: {} }))[0]).toEqual({ service_tier: "priority" });
  h.ctx.model.provider = "anthropic";
  await expect(h.command("fast", "on")).rejects.toThrow("requires");
  await h.command("fast", "off");
  expect((await h.emit("before_provider_request", { payload: {} }))[0]).toBeUndefined();
});

test("workers inherit priority once, with saved preferences and provider gating", async () => {
  const keys = ["PI_SWARM_RUN", "PI_SWARM_NODE", "PI_SWARM_FAST_MODE"] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.PI_SWARM_RUN = "run"; process.env.PI_SWARM_NODE = "worker";
    for (const { mode, saved, provider, expected, worker } of [
      { mode: "on", provider: "openai", expected: true, worker: true },
      { mode: "off", provider: "openai-codex", expected: false, worker: true },
      { mode: "on", saved: false, provider: "openai", expected: true, worker: true },
      { mode: "off", saved: true, provider: "openai-codex", expected: false, worker: true },
      { mode: "on", provider: "anthropic", expected: false, worker: true },
      { mode: "on", provider: "openai", expected: false, worker: false },
    ]) {
      process.env.PI_SWARM_FAST_MODE = mode;
      if (worker) process.env.PI_SWARM_NODE = "worker"; else delete process.env.PI_SWARM_NODE;
      const h = harness(); install(h.pi); h.ctx.model = { provider };
      if (saved !== undefined) h.pi.appendEntry("pi:fast", saved);
      await h.emit("session_start");
      expect((await h.emit("before_provider_request", { payload: {} }))[0]).toEqual(expected ? { service_tier: "priority" } : undefined);
      if (worker) {
        expect(h.entries.at(-1).data).toBe(expected);
        expect(process.env.PI_SWARM_FAST_MODE).toBeUndefined();
        const reloaded = harness(); reloaded.ctx.model = { provider }; reloaded.entries.push(...h.entries);
        install(reloaded.pi); await reloaded.emit("session_start");
        expect((await reloaded.emit("before_provider_request", { payload: {} }))[0]).toEqual(expected ? { service_tier: "priority" } : undefined);
      }
      await h.command("fast", "off");
      await h.emit("session_start");
      await h.emit("session_tree");
      expect((await h.emit("before_provider_request", { payload: {} }))[0]).toBeUndefined();
    }
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test("Ctrl+F toggles the persisted request tier and can turn off on any provider", async () => {
  const h = harness(); install(h.pi);
  h.ctx.model = { provider: "openai-codex" };
  const toggle = h.shortcuts.get("ctrl+f").handler;
  await toggle(h.ctx);
  expect((await h.emit("before_provider_request", { payload: {} }))[0]).toEqual({ service_tier: "priority" });
  expect(h.entries.at(-1).data).toBe(true);
  h.ctx.model = { provider: "anthropic" };
  await toggle(h.ctx);
  expect(h.entries.at(-1).data).toBe(false);
  await toggle(h.ctx);
  expect(h.entries.at(-1).data).toBe(false);
});
