import { expect, test } from "bun:test";
import { compactRemote, readCheckpoint } from "./transport.ts";
const item = { type: "compaction", encrypted_content: "synthetic-opaque" };
const completed = JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } });
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64url")}.test`;

test("reads arbitrarily split SSE UTF-8 and CRLF without exposing intermediate events", async () => {
  const bytes = Buffer.from(`: ping\r\n\r\ndata: {"type":"response.created","note":"é"}\r\n\r\ndata: ${completed}\r\n\r\ndata: [DONE]\r\n\r\n`);
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  expect(await readCheckpoint(new Response(stream))).toEqual(item);
});
test("rejects malformed, failed, duplicate and unfinished streams with sanitized errors", async () => {
  for (const data of ["data: invalid\n\n", 'data: {"type":"response.failed","secret":"not-for-errors"}\n\n',
    `data: ${completed}\n\ndata: ${completed}\n\n`, "data: [DONE]\n\n"]) {
    await expect(readCheckpoint(new Response(data))).rejects.toThrow();
  }
  await expect(readCheckpoint(new Response("private response", { status: 401 }))).rejects.toThrow("HTTP 401");
});
test("local HTTP boundary uses v2 endpoint payload and returns retained users plus checkpoint", async () => {
  let received: any;
  const server = Bun.serve({ port: 0, async fetch(request) {
    received = { body: await request.json(), path: new URL(request.url).pathname, headers: request.headers };
    return new Response(`data: ${completed}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    const result = await compactRemote({ model: "gpt-5.4", input: [{ role: "user", content: "task" }] }, "session", token,
      new AbortController().signal, { endpoint: `http://localhost:${server.port}/backend-api/codex/responses` });
    expect(received.path).toBe("/backend-api/codex/responses");
    expect(received.headers.get("chatgpt-account-id")).toBe("synthetic");
    expect(received.headers.get("x-codex-beta-features")).toBe("remote_compaction_v2");
    expect(received.body.input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(result.at(-1)).toEqual(item);
    expect(result[0].role).toBe("user");
  } finally { await server.stop(true); }
});
test("abort prevents the request and invalid credentials never reach transport", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(compactRemote({ model: "gpt-5.4", input: [] }, "session", token, controller.signal)).rejects.toThrow();
  let called = false;
  await expect(compactRemote({ input: [] }, "session", "invalid", new AbortController().signal,
    { request: (async () => { called = true; return new Response(); }) as typeof fetch })).rejects.toThrow("credentials");
  expect(called).toBe(false);
});
test("cancels an in-flight response rather than accepting an incomplete checkpoint", async () => {
  let began!: () => void;
  const ready = new Promise<void>(resolve => { began = resolve; });
  let streamController: ReadableStreamDefaultController;
  const server = Bun.serve({ port: 0, fetch() {
    return new Response(new ReadableStream({ start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
      began();
    } }));
  } });
  const controller = new AbortController();
  try {
    const pending = compactRemote({ model: "gpt-5.4", input: [] }, "session", token, controller.signal,
      { endpoint: `http://localhost:${server.port}/backend-api/codex/responses` });
    const outcome = pending.then(() => null, error => error);
    await ready; controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
  } finally { try { streamController!.close(); } catch {} await server.stop(true); }
});
test("reader cancellation interrupts a stalled stream after headers", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const outcome = readCheckpoint(response, controller.signal).then(() => null, error => error);
  controller.abort();
  expect(await outcome).toBeInstanceOf(Error);
  expect(cancelled).toBe(true);
});

test("assembles checkpoints delivered before an output-less completion", async () => {
  for (const response of [{}, { status: "completed", output: [] }]) {
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { type: "compaction" } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    expect(await readCheckpoint(new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")))).toEqual(item);
  }
});

test("stream assembly still rejects unfinished or extra output", async () => {
  for (const events of [
    [{ type: "response.output_item.done", output_index: 0, item }],
    [{ type: "response.output_item.done", output_index: 1, item }, { type: "response.completed", response: {} }],
    [{ type: "response.output_item.done", output_index: 0, item },
      { type: "response.output_item.done", output_index: 1, item: { type: "message" } },
      { type: "response.completed", response: {} }],
  ]) await expect(readCheckpoint(new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")))).rejects.toThrow();
});
