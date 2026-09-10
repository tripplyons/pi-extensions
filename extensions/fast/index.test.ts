import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { registerOpenAICodexCustomProvider } from "@howaboua/pi-codex-conversion/dist/providers/openai-codex-custom-provider.js";
import fastExtension from "./index";

function setup(entries: any[] = []) {
  const handlers = new Map<string, Function>();
  const statuses = new Map<string, string | undefined>();
  const notices: string[] = [];
  let command: { handler: Function };
	const eventHandlers = new Map<string, Function>();
  const ctx = {
    model: {
      id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex",
      api: "openai-codex-responses", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 4096,
    },
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      notify: (message: string) => notices.push(message),
    },
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionCommandContext;
  fastExtension({
		events: { on: (name: string, handler: Function) => { eventHandlers.set(name, handler); return () => eventHandlers.delete(name); } },
    on: (name: string, handler: Function) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    registerCommand: (_name: string, value: { handler: Function }) => { command = value; },
  } as unknown as ExtensionAPI);
  return {
    ctx, entries, statuses, notices,
    toggle: (args = "") => command.handler(args, ctx),
    start: (reason: string) => handlers.get("session_start")!({ reason }, ctx),
		fast: () => { const query: { enabled?: boolean } = {}; eventHandlers.get("fast:query")!(query); return query.enabled; },
    request: (payload: unknown) => handlers.get("before_provider_request")!({ payload }, ctx) ?? payload,
  };
}

test("toggle overrides request tier without changing the original request", async () => {
  const session = setup();
  const payload = { model: "gpt-5.4", service_tier: "priority", reasoning: { effort: "high" } };
  expect(session.request(payload)).toBe(payload);
	await session.toggle();
	expect(session.fast()).toBe(true);
  expect(session.request(payload).service_tier).toBe("priority");
  expect(session.statuses.get("fast")).toBe("fast");
	await session.toggle();
	expect(session.fast()).toBe(false);
  expect(session.request(payload)).toEqual({ ...payload, service_tier: "default" });
  expect(payload.service_tier).toBe("priority");
  expect(session.statuses.get("fast")).toBeUndefined();
});

test("reloads, resumes, restarts, and forks restore branch state", async () => {
  const entries: any[] = [];
  const session = setup(entries);
  const payload = { model: "gpt-5.4" };
  session.start("startup");
  await session.toggle();

  for (const reason of ["reload", "resume", "startup", "fork"]) {
    const restored = setup([...entries]);
    restored.start(reason);
    expect(restored.request(payload).service_tier).toBe("priority");
    expect(restored.fast()).toBe(true);
    expect(restored.statuses.get("fast")).toBe("fast");
  }

  const fresh = setup();
  fresh.start("new");
  expect(fresh.request(payload)).toBe(payload);
  expect(fresh.statuses.get("fast")).toBeUndefined();
});

test("forced default persists separately and session histories stay isolated", async () => {
  const entries: any[] = [];
  const session = setup(entries);
  await session.toggle();
  await session.toggle();

  const resumed = setup(entries);
  resumed.start("resume");
  expect(resumed.request({ model: "gpt-5.4" }).service_tier).toBe("default");
  expect(resumed.fast()).toBe(false);
  expect(resumed.statuses.get("fast")).toBeUndefined();

  const other = setup();
  other.start("startup");
  expect(other.request({ model: "gpt-5.4" })).toEqual({ model: "gpt-5.4" });
});

test("restores the latest valid entry and ignores malformed state", () => {
  const session = setup([
    { type: "custom", customType: "fast-state", data: { enabled: true } },
    { type: "custom", customType: "fast-state", data: { enabled: "yes" } },
    { type: "custom", customType: "other", data: { enabled: false } },
  ]);
  session.start("resume");
  expect(session.request({}).service_tier).toBe("priority");
});

test("rejects arguments and leaves other providers alone", async () => {
  const session = setup();
  const payload = { model: "other" };
  await session.toggle("on");
  expect(session.entries).toHaveLength(0);
  expect(session.request(payload)).toBe(payload);
  await session.toggle();
  expect(session.entries).toHaveLength(1);
  session.ctx.model = { ...session.ctx.model!, provider: "anthropic" };
  expect(session.request(payload)).toBe(payload);
  await session.toggle();
  expect(session.notices.at(-1)).toContain("requires an OpenAI Codex model");
  expect(session.entries).toHaveLength(1);
});

test("pinned Codex provider sends the toggled tier over HTTP", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const body = request.headers.get("content-encoding") === "zstd"
        ? Bun.zstdDecompressSync(bytes) : bytes;
      requests.push(JSON.parse(new TextDecoder().decode(body)));
      return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    let provider: Provider;
    registerOpenAICodexCustomProvider({
      registerProvider: (value: Provider) => { provider = value; },
    } as unknown as ExtensionAPI, { useResponsesLite: () => false });
    const session = setup();
    const model = { ...session.ctx.model!, baseUrl: `http://127.0.0.1:${server.port}` };
    const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
    for (let index = 0; index < 3; index++) {
      if (index > 0) await session.toggle();
      const stream = provider!.streamSimple(model, {
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
      }, {
        apiKey: token, transport: "sse", maxRetries: 0,
        onPayload: (payload) => session.request(payload),
      });
      const result = await stream.result();
      expect(result.stopReason).not.toBe("error");
    }
    expect(requests.map((request) => request.service_tier)).toEqual([undefined, "priority", "default"]);
  } finally {
    server.stop(true);
  }
});
