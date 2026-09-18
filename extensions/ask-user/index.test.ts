import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";
test("Unicode and suggestions produce free text, cancellation is not an answer", async () => {
  const h = harness(); install(h.pi);
  expect((await h.call("ask_user", { question: "Pi’s config?", choices: ["全て"] })).details.answer).toBe("answer");
  h.ctx.ui.input = async () => undefined;
  await expect(h.call("ask_user", { question: "Q?", choices: [] })).rejects.toThrow("cancelled");
  h.ctx.hasUI = false;
  await expect(h.call("ask_user", { question: "Q?", choices: [] })).rejects.toThrow("interactive");
});

test("answers are plain text with structured details preserved", async () => {
  const h = harness(); install(h.pi);
  const answer = 'Use Pi’s defaults.\nKeep "全て" as a suggestion.';
  h.ctx.ui.input = async () => answer;
  const response = await h.call("ask_user", { question: "Which settings?", choices: [] });
  expect(response.content).toEqual([{ type: "text", text: answer }]);
  expect(response.details).toEqual({ answer });
});

test("suggestions appear on separate numbered lines beneath the question", async () => {
  const h = harness(); install(h.pi);
  let title: string | undefined;
  h.ctx.ui.input = async (value: string) => { title = value; return "Something else"; };
  const response = await h.call("ask_user", {
    question: "Which settings?", choices: ["Pi defaults", "全て", "Custom | settings"],
  });
  expect(title).toBe("Which settings?\n\nSuggestions:\n1. Pi defaults\n2. 全て\n3. Custom | settings");
  expect(response.details.answer).toBe("Something else");
});

test("questions without suggestions omit the list", async () => {
  const h = harness(); install(h.pi);
  let title: string | undefined;
  h.ctx.ui.input = async (value: string) => { title = value; return "Answer"; };
  await h.call("ask_user", { question: "Which settings?", choices: [] });
  expect(title).toBe("Which settings?");
});
