import { afterEach, expect, test } from "bun:test";
import { createModels, getSupportedThinkingLevels, type Context, type ModelThinkingLevel, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import lmStudio, { lmStudioProvider } from "./index";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

const catalog = { models: [
  { type: "llm", key: "qwen", display_name: "Qwen", max_context_length: 131072,
    loaded_instances: [{ id: "custom-instance", config: { context_length: 50176 } }],
    capabilities: { vision: true, reasoning: { allowed_options: ["off", "on"] } } },
  { type: "llm", key: "unloaded", max_context_length: 65536, loaded_instances: [] },
  { type: "embedding", key: "nomic" },
] };

function setup(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  const provider = lmStudioProvider(`${server.url}v1/`, "test-token");
  const registry = createModels();
  registry.setProvider(provider);
  return { provider, registry };
}

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };
function stream(chunks: unknown[]) {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}
function chunk(delta: unknown, finish_reason: string | null = null) {
  return { id: "chat-1", object: "chat.completion.chunk", created: 1, model: "custom-instance",
    choices: [{ index: 0, delta, finish_reason }] };
}

test("discovers chat models, instance IDs, loaded limits, capabilities, and keyless auth", async () => {
  const { provider, registry } = setup(request => {
    expect(new URL(request.url).pathname).toBe("/api/v1/models");
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
    return Response.json(catalog);
  });
  expect((await registry.refresh()).errors.size).toBe(0);
  expect(provider.getModels().map(model => model.id)).toEqual(["custom-instance", "unloaded"]);
  expect(provider.getModels()[0]).toMatchObject({
    name: "Qwen", contextWindow: 50176, input: ["text", "image"], reasoning: true,
    maxTokens: 8192, thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null,
      high: "high", xhigh: null, max: null },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  expect(provider.getModels()[1]).toMatchObject({ contextWindow: 65536, reasoning: false, input: ["text"] });
  expect((await registry.getAvailable()).map(model => model.id)).toEqual(["custom-instance", "unloaded"]);
});

const reasoningLevels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const reasoningCases: {
  name: string;
  options?: string[];
  supported: ModelThinkingLevel[];
  // Default request, then every Pi level. Unsupported requests must clamp to a supported setting.
  efforts: (string | undefined)[];
}[] = [
  { name: "toggle", options: ["off", "on"], supported: ["off", "high"],
    efforts: ["none", "none", "high", "high", "high", "high", "high", "high"] },
  { name: "always-on", options: ["on"], supported: ["high"],
    efforts: [undefined, "high", "high", "high", "high", "high", "high", "high"] },
  { name: "graded", options: ["low", "medium", "high"], supported: ["low", "medium", "high"],
    efforts: [undefined, "low", "low", "low", "medium", "high", "high", "high"] },
  { name: "graded-with-off", options: ["off", "low", "medium", "high"], supported: ["off", "low", "medium", "high"],
    efforts: ["none", "none", "low", "low", "medium", "high", "high", "high"] },
  { name: "sparse", options: ["off", "low", "high"], supported: ["off", "low", "high"],
    efforts: ["none", "none", "low", "low", "high", "high", "high", "high"] },
  { name: "low-only", options: ["low"], supported: ["low"],
    efforts: [undefined, "low", "low", "low", "low", "low", "low", "low"] },
  { name: "medium-only", options: ["medium"], supported: ["medium"],
    efforts: [undefined, "medium", "medium", "medium", "medium", "medium", "medium", "medium"] },
  { name: "high-only", options: ["high"], supported: ["high"],
    efforts: [undefined, "high", "high", "high", "high", "high", "high", "high"] },
  ...[undefined, [], ["off"], ["unknown", "minimal", "xhigh", "max"]].map((options, index) => ({
    name: `non-reasoning-${index}`, options, supported: ["off"] as ModelThinkingLevel[],
    efforts: Array<string | undefined>(8).fill(undefined),
  })),
];

for (const { name, options, supported, efforts } of reasoningCases) {
  test(`catalog reasoning ${name} exposes only supported choices and sends valid efforts`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const { provider, registry } = setup(async request => {
      if (request.method === "GET") return Response.json({ models: [{ type: "llm", key: name,
        capabilities: { reasoning: options === undefined ? undefined : { allowed_options: options } } }] });
      bodies.push(await request.json());
      return stream([chunk({ content: "Hello" }), chunk({}, "stop")]);
    });
    expect((await registry.refresh()).errors.size).toBe(0);
    const model = registry.getModel("lm-studio", name)!;
    expect(getSupportedThinkingLevels(model)).toEqual(supported);
    const reasoning = supported.some(level => level !== "off");
    expect(model.reasoning).toBe(reasoning);
    expect(provider.getModels()[0].compat?.supportsReasoningEffort).toBe(reasoning);
    for (const level of [undefined, ...reasoningLevels]) {
      const result = await registry.completeSimple(model, context, { reasoning: level, maxTokens: 16 });
      expect(result.stopReason).toBe("stop");
    }
    expect(bodies).toHaveLength(efforts.length);
    expect(bodies.map(body => body.reasoning_effort)).toEqual(efforts);
    if (!reasoning) expect(model.thinkingLevelMap).toBeUndefined();
  });
}

test("refresh replaces models, accepts an empty catalog, and never persists local state", async () => {
  let data: unknown = catalog;
  const { provider, registry } = setup(() => Response.json(data));
  await registry.refresh();
  data = { models: [{ type: "llm", key: "new" }] };
  await registry.refresh();
  expect(provider.getModels()).toHaveLength(1);
  expect(provider.getModels()[0]).toMatchObject({ id: "new", contextWindow: 32768 });
  data = { models: [] };
  await provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal,
    publish: async publication => {
      expect(publication.persist).toBeUndefined();
      publication.update?.();
      return true;
    } });
  expect(provider.getModels()).toEqual([]);
});

test("failed discovery preserves the previous catalog and does not expose response bodies", async () => {
  let fail = false;
  const { provider, registry } = setup(() => fail ? new Response("secret server error", { status: 401 }) : Response.json(catalog));
  await registry.refresh();
  fail = true;
  const result = await registry.refresh();
  expect(result.errors.get("lm-studio")?.message).toContain("HTTP 401");
  expect(result.errors.get("lm-studio")?.message).not.toContain("secret");
  expect(provider.getModels()).toHaveLength(2);
});

test("invalid catalogs do not replace valid models", async () => {
  let data: unknown = catalog;
  const { provider, registry } = setup(() => Response.json(data));
  await registry.refresh();
  for (const invalid of [{ data: [] }, { models: [{ type: "llm" }] }]) {
    data = invalid;
    expect((await registry.refresh()).errors.size).toBe(1);
    expect(provider.getModels()).toHaveLength(2);
  }
});

test("offline refresh, canceled refresh, and rejected publication leave the catalog unchanged", async () => {
  let requests = 0;
  const { provider } = setup(() => { requests++; return Response.json(catalog); });
  const publish = async () => false;
  await provider.refreshModels!({ allowNetwork: false, signal: new AbortController().signal, publish });
  await provider.refreshModels!({ allowNetwork: true, signal: AbortSignal.abort(), publish });
  expect(requests).toBe(0);
  await provider.refreshModels!({ allowNetwork: true, signal: new AbortController().signal, publish });
  expect(requests).toBe(1);
  expect(provider.getModels()).toEqual([]);
});

test("streaming uses LM Studio fields and preserves Unicode, usage, and zero cost", async () => {
  const { registry } = setup(async request => {
    if (request.method === "GET") return Response.json(catalog);
    expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
    const body = await request.json();
    expect(body).toMatchObject({ model: "custom-instance", max_tokens: 16, reasoning_effort: "none", stream: true });
    expect(body.store).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    return stream([chunk({ role: "assistant", content: "Héllo 世界" }), chunk({}, "stop"),
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }]);
  });
  await registry.refresh();
  const result = await registry.completeSimple(registry.getModel("lm-studio", "custom-instance")!, context, { reasoning: "off", maxTokens: 16 });
  expect(result.stopReason).toBe("stop");
  expect(result.content).toEqual([{ type: "text", text: "Héllo 世界" }]);
  expect(result.usage).toMatchObject({ input: 9, output: 3, totalTokens: 12, cost: { total: 0 } });
});

test("tool calls stream through Pi and tool results replay on the next request", async () => {
  let calls = 0;
  const { registry } = setup(async request => {
    if (request.method === "GET") return Response.json(catalog);
    const body = await request.json();
    if (++calls === 1) return stream([
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"hello.ts"}' } }] }), chunk({}, "tool_calls"),
    ]);
    expect(body.messages.some((message: any) => message.role === "tool" && message.content === "file contents")).toBe(true);
    return stream([chunk({ content: "Done" }), chunk({}, "stop")]);
  });
  await registry.refresh();
  const model = registry.getModel("lm-studio", "custom-instance")!;
  const first = await registry.completeSimple(model, context);
  expect(first.stopReason).toBe("toolUse");
  expect(first.content[0]).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "hello.ts" } });
  const toolCall = first.content[0] as { id: string };
  const second = await registry.completeSimple(model, { messages: [...context.messages, first,
    { role: "toolResult", toolCallId: toolCall.id, toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 0 }] });
  expect(second.stopReason).toBe("stop");
});

test("empty responses and context-overflow errors retain Pi's native semantics", async () => {
  let fail = false;
  const { registry } = setup(request => request.method === "GET" ? Response.json(catalog)
    : fail ? Response.json({ error: { message: "context_length_exceeded", type: "invalid_request_error" } }, { status: 400 })
    : stream([chunk({}, "stop")]));
  await registry.refresh();
  const model = registry.getModel("lm-studio", "custom-instance")!;
  const empty = await registry.completeSimple(model, context);
  expect(empty.stopReason).toBe("stop");
  expect(empty.content).toEqual([]);
  fail = true;
  const error = await registry.completeSimple(model, context);
  expect(error.stopReason).toBe("error");
  expect(error.errorMessage).toContain("context_length_exceeded");
});

test("aborted streaming returns an aborted result", async () => {
  const { registry } = setup(request => request.method === "GET" ? Response.json(catalog)
    : stream([chunk({ content: "Hello" }), chunk({}, "stop")]));
  await registry.refresh();
  const controller = new AbortController();
  const result = await registry.completeSimple(registry.getModel("lm-studio", "custom-instance")!, context, {
    signal: controller.signal, onProviderStreamEvent: () => { controller.abort(); },
  });
  expect(result.stopReason).toBe("aborted");
});

test("offline startup still registers a provider and the refresh command reports errors", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) });
  servers.push(server);
  let registered: Provider | undefined;
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const previous = process.env.LM_STUDIO_BASE_URL;
  process.env.LM_STUDIO_BASE_URL = server.url.href;
  try {
    await lmStudio({
      registerProvider: (provider: Provider) => { registered = provider; },
      registerCommand: (name: string, definition: typeof command) => { expect(name).toBe("lm-studio"); command = definition; },
    } as ExtensionAPI);
  } finally {
    if (previous === undefined) delete process.env.LM_STUDIO_BASE_URL;
    else process.env.LM_STUDIO_BASE_URL = previous;
  }
  expect(registered?.id).toBe("lm-studio");
  expect(registered?.getModels()).toEqual([]);
  const notices: string[] = [];
  await command!.handler("", {
    modelRegistry: { refresh: async (options: unknown) => {
      expect(options).toEqual({ providers: ["lm-studio"], force: true });
      return { errors: new Map([["lm-studio", new Error("Server unavailable")]]), aborted: false };
    } },
    ui: { notify: (message: string, level: string) => { notices.push(message); expect(level).toBe("error"); } },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual(["Server unavailable"]);
});

test("base URL accepts origin or /v1 and rejects embedded secrets and invalid protocols", () => {
  expect(lmStudioProvider("http://localhost:1234").baseUrl).toBe("http://localhost:1234/v1");
  for (const url of ["file:///tmp", "http://user:pass@localhost:1234", "http://localhost:1234?key=secret"]) {
    expect(() => lmStudioProvider(url)).toThrow("LM_STUDIO_BASE_URL");
  }
});
