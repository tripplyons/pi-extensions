import { expect, test } from "bun:test";
import { createModels, createAssistantMessageEventStream, type Model, type Provider, type Credential } from "@earendil-works/pi-ai";
import { guardProvider, isOpenAI, assertSubscription } from "./index.ts";

const model: Model<any> = {
  provider: "openai", id: "gpt-6.1-sol", name: "GPT", api: "openai-responses",
  baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text"],
  contextWindow: 272000, maxTokens: 128000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = { messages: [] };
const credential = {
  type: "oauth" as const, access: "opaque-subscription-token", refresh: "synthetic-refresh",
  expires: Date.now() + 3_600_000, scopes: ["chatgpt.tokens.use.direct"],
};
function fixture(stored: Credential | undefined | null = credential, target = model) {
  let calls = 0;
  const stream: Provider["streamSimple"] = request => {
    calls++;
    const value: any = {
      role: "assistant", content: [], api: request.api, provider: request.provider, model: request.id,
      timestamp: 1, stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const result = createAssistantMessageEventStream();
    result.push({ type: "done", reason: "stop", message: value });
    result.end();
    return result;
  };
  const provider: Provider = {
    id: target.provider, name: target.provider, getModels: () => [target],
    auth: {
      apiKey: { name: "API key", resolve: async input => ({
        auth: { apiKey: input.credential?.key ?? await input.ctx.env("OPENAI_API_KEY") },
      }) },
      oauth: { name: "ChatGPT", isSubscription: true,
        login: async () => credential, refresh: async value => value,
        toAuth: async value => ({ apiKey: value.access }) },
    },
    stream: stream as Provider["stream"], streamSimple: stream,
    fetchDeferred: request => stream(request, { messages: [] }),
    cancelDeferred: async () => { calls++; },
    generateImages: async () => { calls++; return {} as any; },
    classify: async () => { calls++; return {} as any; },
  };
  const guarded = guardProvider(provider);
  const runtime = createModels({
    credentials: {
      read: async () => stored ?? undefined, list: async () => [],
      modify: async (_id, update) => update(stored ?? undefined), delete: async () => {},
    },
    authContext: { env: async () => "sk-synthetic-env-key", fileExists: async () => false },
  });
  runtime.setProvider(guarded);
  return { runtime, provider: guarded, calls: () => calls };
}

test("native ChatGPT OAuth accepts opaque tokens and refresh resolutions, without an API-key login", async () => {
  const f = fixture();
  expect(f.provider.auth.apiKey?.login).toBeUndefined();
  expect((await f.runtime.completeSimple(model, context)).stopReason).toBe("stop");
  expect(f.calls()).toBe(1);
});

for (const [name, stored, options] of [
  ["environment key", null, undefined],
  ["stored API key", { type: "api_key", key: "sk-synthetic" }, undefined],
  ["explicit override with OAuth present", credential, { apiKey: "sk-synthetic" }],
  ["missing subscription scope", { ...credential, scopes: [] }, undefined],
  ["key disguised as OAuth", { ...credential, access: "sk-synthetic" }, undefined],
] as const) {
  test(`blocks ${name} before provider dispatch`, async () => {
    const f = fixture(stored as Credential | undefined);
    const result = await f.runtime.completeSimple(model, context, options);
    expect(result.stopReason).toBe("error");
    expect(f.calls()).toBe(0);
  });
}

test("verified OAuth can be passed through apiKey again, but unverified opaque tokens cannot", async () => {
  const f = fixture();
  const resolved = await f.runtime.getAuth(model);
  expect(resolved?.source).toBe("OAuth");
  const replay = await f.runtime.completeSimple(model, context, { apiKey: resolved!.auth.apiKey });
  expect(replay.stopReason).toBe("stop");
  expect(f.calls()).toBe(1);
  const unknown = await f.runtime.completeSimple(model, context, { apiKey: "unverified-opaque-token" });
  expect(unknown.stopReason).toBe("error");
  expect(f.calls()).toBe(1);
});

test("model and request headers cannot select an API key or billing project", async () => {
  for (const headers of [
    { Authorization: "Bearer sk-synthetic" }, { "api-key": "sk-synthetic" },
    { "OpenAI-Project": "synthetic-project" }, { "OpenAI-Organization": "synthetic-org" },
  ]) {
    const f = fixture();
    expect((await f.runtime.completeSimple({ ...model, headers }, context)).stopReason).toBe("error");
    expect((await f.runtime.completeSimple(model, context, { headers })).stopReason).toBe("error");
    expect(f.calls()).toBe(0);
  }
});

test("paid gateways, custom endpoints, Azure, and OpenAI image models are blocked", async () => {
  for (const target of [
    { ...model, provider: "openrouter", id: "openai/gpt-6.1-sol" },
    { ...model, provider: "gateway", id: "gpt-6.1-sol", baseUrl: "https://gateway.invalid/v1" },
    { ...model, provider: "azure", baseUrl: "https://fixture.openai.azure.com" },
    { ...model, baseUrl: "https://api.openai.com/v1/other" },
    { ...model, api: "openai-completions" },
  ]) {
    const f = fixture(credential, target);
    expect((await f.runtime.completeSimple(target, context)).stopReason).toBe("error");
    expect(f.calls()).toBe(0);
  }
});

test("direct, deferred, title-style, image, and classifier calls share the guard", async () => {
  const f = fixture();
  const options = { apiKey: "sk-synthetic" };
  for (const stream of [
    f.provider.stream(model, context, options),
    f.provider.streamSimple(model, context, options),
    f.provider.fetchDeferred!(model, {} as any, options),
  ]) expect((await stream.result()).stopReason).toBe("error");
  await expect(f.provider.cancelDeferred!(model, {} as any, options)).rejects.toThrow("API billing");
  await expect(f.provider.generateImages!({ ...model, id: "gpt-image-1", type: "image" } as any, { input: [] }, options)).rejects.toThrow("API billing");
  await expect(f.provider.classify!(model as any, {} as any, options)).rejects.toThrow("API billing");
  expect(f.calls()).toBe(0);
});

test("existing Codex OAuth remains allowed and non-OpenAI providers stay unchanged", async () => {
  const codex = { ...model, provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
  const f = fixture({ ...credential, scopes: [] }, codex);
  expect((await f.runtime.completeSimple(codex, context)).stopReason).toBe("stop");
  const deepseek = { ...model, provider: "makora", id: "deepseek-ai/DeepSeek-V4-Flash", api: "openai-completions", baseUrl: "https://inference.makora.com/v1" };
  expect(isOpenAI(deepseek)).toBe(false);
  expect(() => assertSubscription(deepseek, { apiKey: "sk-synthetic" }, new Set())).not.toThrow();
  const other = fixture({ type: "api_key", key: "synthetic-key" }, deepseek);
  expect((await other.runtime.completeSimple(deepseek, context)).stopReason).toBe("stop");
  expect(other.calls()).toBe(1);
});
