import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { registerOpenAICodexCustomProvider } from "@howaboua/pi-codex-conversion/dist/providers/openai-codex-custom-provider.js";
import fastExtension from "./index";

function setup() {
  const handlers = new Map<string, Function>();
  const statuses = new Map<string, string | undefined>();
  const notices: string[] = [];
  let command: { handler: Function };
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
  } as unknown as ExtensionCommandContext;
  fastExtension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (_name: string, value: { handler: Function }) => { command = value; },
  } as unknown as ExtensionAPI);
  return {
    ctx, statuses, notices,
    toggle: (args = "") => command.handler(args, ctx),
    start: (reason: string) => handlers.get("session_start")!({ reason }, ctx),
    request: (payload: unknown) => handlers.get("before_provider_request")!({ payload }, ctx) ?? payload,
  };
}

test("toggle overrides request tier without changing the original request", async () => {
  const session = setup();
  const payload = { model: "gpt-5.4", service_tier: "priority", reasoning: { effort: "high" } };
  expect(session.request(payload)).toBe(payload);
  await session.toggle();
  expect(session.request(payload).service_tier).toBe("priority");
  await session.toggle();
  expect(session.request(payload)).toEqual({ ...payload, service_tier: "default" });
  expect(payload.service_tier).toBe("priority");
  expect(session.statuses.get("session-fast")).toBe("session fast: off");
});

test("session lifecycle clears the override and instances remain isolated", async () => {
  const session = setup();
  const other = setup();
  const payload = { model: "gpt-5.4" };
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    await session.toggle();
    expect(session.request(payload).service_tier).toBe("priority");
    expect(other.request(payload)).toBe(payload);
    session.start(reason);
    expect(session.request(payload)).toBe(payload);
    expect(session.statuses.get("session-fast")).toBeUndefined();
  }
});

test("rejects arguments and leaves other providers alone", async () => {
  const session = setup();
  const payload = { model: "other" };
  await session.toggle("on");
  expect(session.request(payload)).toBe(payload);
  await session.toggle();
  session.ctx.model = { ...session.ctx.model!, provider: "anthropic" };
  expect(session.request(payload)).toBe(payload);
  await session.toggle();
  expect(session.notices.at(-1)).toContain("requires an OpenAI Codex model");
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
