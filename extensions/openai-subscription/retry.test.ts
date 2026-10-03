import { expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { retryableStream } from "./index.ts";

const premature = "upstream stream ended before a completion event; this turn may be incomplete";
function failure(errorMessage: string, aborted = false): AssistantMessageEvent {
  const error: AssistantMessage = {
    role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-6.1-sol",
    content: [], timestamp: 1, stopReason: aborted ? "aborted" : "error", errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  return { type: "error", reason: aborted ? "aborted" : "error", error };
}
async function* events(event: AssistantMessageEvent) { yield event; }

test("premature Responses EOF reaches Pi's bounded native retry policy", async () => {
  const original = failure(premature);
  const result = await Array.fromAsync(retryableStream(events(original)));
  expect(result).toHaveLength(1);
  const event = result[0];
  if (event.type !== "error" || original.type !== "error") throw new Error("Expected error events");
  expect(isRetryableAssistantError(original.error)).toBe(false);
  expect(isRetryableAssistantError(event.error)).toBe(true);
  expect(event.error.stopReason).toBe("error");
  expect(event.error.errorMessage).toBe(`Connection error: ${premature}`);
  expect(original.error.errorMessage).toBe(premature);
  expect(event.error.content).toBe(original.error.content);
});

test("abort, billing, auth, and other failures pass through without retry relabeling", async () => {
  for (const event of [failure(premature, true), failure("insufficient_quota"), failure("Unauthorized"), failure("invalid tool arguments")]) {
    const result = await Array.fromAsync(retryableStream(events(event)));
    expect(result).toEqual([event]);
    expect(result[0]).toBe(event);
  }
});
