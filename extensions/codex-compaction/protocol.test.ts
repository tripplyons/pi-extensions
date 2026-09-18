import { expect, test } from "bun:test";
import { checkpoint, compactRequest, pairedInput, retainedUsers } from "./protocol.ts";

test("compaction pairs calls, excludes unfinished calls and rejects orphaned outputs", () => {
  const call = { type: "function_call", call_id: "a" };
  const output = { type: "function_call_output", call_id: "a", output: "ok" };
  expect(pairedInput([call])).toEqual([]);
  expect(pairedInput([call, output])).toEqual([call, output]);
  expect(() => pairedInput([output, call])).toThrow("Orphaned");
  expect(() => pairedInput([call, call])).toThrow("duplicate");
  expect(() => pairedInput([call, output, output])).toThrow("Orphaned");
});
test("retains newest user text within a UTF-8 byte budget, without images", () => {
  expect(retainedUsers([
    { role: "user", content: "old" },
    { role: "assistant", content: "ignore" },
    { role: "user", content: [{ type: "input_image" }, { type: "input_text", text: "ééé" }] },
  ], 5)).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "o" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "éé" }] },
  ]);
});
test("v2 request preserves source, merges feature header and uses Astra overrides", () => {
  const body = { model: "gpt-6-astra", input: [{ role: "user", content: "task" }], previous_response_id: "old" };
  const request = compactRequest(body, "session", { "X-Codex-Beta-Features": "other,remote_compaction_v2" });
  expect(request.body.input).toEqual([...body.input, { type: "compaction_trigger" }]);
  expect(request.body.previous_response_id).toBeUndefined();
  expect(body.previous_response_id).toBe("old");
  expect(request.body.reasoning).toEqual({ effort: "low", summary: "auto" });
  expect(request.headers["x-codex-beta-features"]).toBe("other,remote_compaction_v2");
  expect(request.headers["x-codex-routing-hint"]).toBe("model=gpt-6-astra;tier=priority");
  expect(request.body.prompt_cache_key).toBe("session");
});
test("only accepts exactly one opaque completed checkpoint", () => {
  const item = { type: "compaction", encrypted_content: "opaque" };
  expect(checkpoint({ status: "completed", output: [item] })).toEqual(item);
  for (const response of [
    { status: "incomplete", output: [item] }, { status: "completed", output: [item, item] },
    { status: "completed", output: [{ ...item, encrypted_content: "" }] },
    { status: "completed", output: [{ type: "message", content: "summary" }] },
  ]) expect(() => checkpoint(response)).toThrow("opaque");
});
