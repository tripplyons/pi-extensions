import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";
test("Unicode and suggestions produce free text, cancellation is not an answer", async () => {
  const h = harness(); install(h.pi);
  expect((await h.call("ask_user", { question: "Stack’s config?", choices: ["全て"] })).details.answer).toBe("answer");
  h.ctx.ui.input = async () => undefined;
  await expect(h.call("ask_user", { question: "Q?", choices: [] })).rejects.toThrow("cancelled");
  h.ctx.hasUI = false;
  await expect(h.call("ask_user", { question: "Q?", choices: [] })).rejects.toThrow("interactive");
});
