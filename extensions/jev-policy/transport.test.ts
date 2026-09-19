import { expect, spyOn, test } from "bun:test";
import { decide, recentText } from "../../lib/jev.ts";
const questions = {
  effort: { type: "choice" as const, instructions: "Choose effort", criteria: { low: "Routine", high: "Difficult" } },
  archive: { type: "boolean" as const, instructions: "Safe to archive?" },
};
const ctx: any = { modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "test-key" } }) } };

test("OpenRouter request uses decisions endpoint, noul questions, and validates response", async () => {
  const mock = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.questions.archive.type).toBe("noul");
    return Response.json({ answers: { effort: { type: "choice", choice: "low" }, archive: { type: "noul", noul: 0.95 } } });
  });
  try {
    expect(await decide(ctx, { task: "test" }, questions)).toEqual({ effort: { choice: "low" }, archive: { probability: 0.95 } });
  } finally { mock.mockRestore(); }
});

test("malformed responses, HTTP failures, missing credentials and oversize inputs fail closed", async () => {
  const mock = spyOn(globalThis, "fetch");
  try {
    for (const response of [Response.json({ answers: { effort: { type: "choice", choice: "max" } } }), Response.json({ answers: [] }), new Response("private upstream detail", { status: 401 })]) {
      mock.mockResolvedValue(response);
      await expect(decide(ctx, {}, questions)).rejects.toThrow();
    }
    const count = mock.mock.calls.length;
    await expect(decide({ modelRegistry: { getProviderAuth: async () => undefined } } as any, {}, questions)).rejects.toThrow("credentials");
    await expect(decide(ctx, { text: "x".repeat(28000) }, questions)).rejects.toThrow("budget");
    const controller = new AbortController(); controller.abort();
    await expect(decide(ctx, {}, questions, controller.signal)).rejects.toThrow();
    expect(mock.mock.calls.length).toBe(count);
  } finally { mock.mockRestore(); }
});

test("recent context excludes reasoning and binary blocks", () => {
  expect(recentText([{ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "visible" }, { type: "image", data: "binary" }] }])).toEqual(["assistant: visible"]);
});
