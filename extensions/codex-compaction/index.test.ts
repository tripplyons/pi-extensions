import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import { installCompaction } from "./index.ts";
function setup(request: any) {
  const h = harness();
  h.ctx.model = { provider: "openai-codex", id: "gpt-5.4" };
  h.ctx.modelRegistry = { getProviderAuth: async () => ({ auth: { apiKey: "synthetic" } }) };
  h.ctx.abort = () => { h.ctx.aborted = true; };
  installCompaction(h.pi, request);
  return h;
}
const input = [{ role: "user", content: "hello" }];
const event = { payload: { model: "gpt-5.4", input } };
const compact = [{ type: "compaction", encrypted_content: "opaque" }];
test("manual compaction persists and projects checkpoint without repeating request", async () => {
  let calls = 0;
  const h = setup(async () => { calls++; return compact; });
  await h.command("codex-compact");
  expect((await h.emit("before_provider_request", event))[0].input).toEqual(compact);
  await h.emit("session_switch");
  expect((await h.emit("before_provider_request", event))[0].input).toEqual(compact);
  expect(calls).toBe(1);
});
test("threshold triggers on Codex usage; other providers pass through", async () => {
  let calls = 0;
  const h = setup(async () => { calls++; return compact; });
  await h.command("threshold", "1k");
  await h.emit("message_end", { message: { role: "assistant", provider: "openai-codex", model: "gpt-5.4", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 1000, cacheWrite: 0 } } });
  await h.emit("before_provider_request", event); expect(calls).toBe(1);
  h.ctx.model.provider = "anthropic";
  expect((await h.emit("before_provider_request", event))[0]).toBeUndefined();
  await expect(h.command("threshold", "0")).rejects.toThrow("positive");
});
test("transport failure aborts provider request and saves no checkpoint", async () => {
  const h = setup(async () => { throw new Error("failure"); });
  await h.command("codex-compact");
  await expect(h.emit("before_provider_request", event)).rejects.toThrow("failure");
  expect(h.ctx.aborted).toBe(true); expect(h.entries).toHaveLength(0);
});
