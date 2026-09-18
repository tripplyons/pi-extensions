import { expect, test } from "bun:test";
import { saveCheckpoint, projectCheckpoint } from "./state.ts";
const binding = { session: "session-a", model: "gpt-5.4", provider: "openai-codex" };
const input = [{ role: "user", content: "first" }, { role: "assistant", content: "answer" }];
const compact = [{ type: "compaction", encrypted_content: "opaque" }];
test("checkpoint persists through JSON and replaces only the verified prefix", () => {
  const saved = JSON.parse(JSON.stringify(saveCheckpoint(binding, input, compact)));
  const tail = { role: "user", content: "next" };
  expect(projectCheckpoint(binding, [...input, tail], saved)).toEqual([...compact, tail]);
  expect(input[0].content).toBe("first");
  const reordered = [{ content: "first", role: "user" }, input[1]];
  expect(projectCheckpoint(binding, reordered, saved)).toEqual(compact);
});
test("different branch, session, model and provider never reuse opaque checkpoints", () => {
  const saved = saveCheckpoint(binding, input, compact);
  for (const other of [{ ...binding, session: "fork" }, { ...binding, model: "other" }, { ...binding, provider: "openai" }]) {
    expect(projectCheckpoint(other, input, saved)).toBe(input);
  }
  const edited = [{ role: "user", content: "edited" }, input[1]];
  expect(projectCheckpoint(binding, edited, saved)).toBe(edited);
  const rewound = input.slice(0, 1);
  expect(projectCheckpoint(binding, rewound, saved)).toBe(rewound);
});
test("replacement ownership is isolated and malformed checkpoints cannot be created", () => {
  const replacement = structuredClone(compact);
  const saved = saveCheckpoint(binding, input, replacement);
  replacement[0].encrypted_content = "mutated";
  const projected = projectCheckpoint(binding, input, saved);
  expect(projected[0].encrypted_content).toBe("opaque");
  projected[0].encrypted_content = "changed";
  expect(saved.replacement[0].encrypted_content).toBe("opaque");
  expect(() => saveCheckpoint(binding, [], compact)).toThrow("empty");
  expect(() => saveCheckpoint(binding, input, [])).toThrow("replacement");
});
