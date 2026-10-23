import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import install, { other } from "./index.ts";

test("questions without choices ask for free text, cancellation is not an answer", async () => {
  const h = harness(); install(h.pi);
  let title: string | undefined;
  h.ctx.ui.select = async () => { throw new Error("no select without choices"); };
  h.ctx.ui.input = async (value: string) => { title = value; return "answer"; };
  expect((await h.call("ask_user", { question: "Pi’s config?", choices: [] })).details).toEqual({ answer: "answer" });
  expect(title).toBe("Pi’s config?");
  h.ctx.ui.input = async () => undefined;
  await expect(h.call("ask_user", { question: "Q?", choices: [] })).rejects.toThrow("cancelled");
  h.ctx.hasUI = false;
  await expect(h.call("ask_user", { question: "Q?", choices: [] })).rejects.toThrow("interactive");
});

test("answers are plain text with structured details preserved", async () => {
  const h = harness(); install(h.pi);
  const answer = 'Use Pi’s defaults.\nKeep "全て" as a choice.';
  h.ctx.ui.input = async () => answer;
  const response = await h.call("ask_user", { question: "Which settings?", choices: [] });
  expect(response.content).toEqual([{ type: "text", text: answer }]);
  expect(response.details).toEqual({ answer });
});

test("a picked choice returns its text and number", async () => {
  const h = harness(); install(h.pi);
  let shown: { title: string; options: string[] } | undefined;
  h.ctx.ui.select = async (title: string, options: string[]) => { shown = { title, options }; return "全て"; };
  h.ctx.ui.input = async () => { throw new Error("no input after a picked choice"); };
  const response = await h.call("ask_user", { question: "Which settings?", choices: ["Pi defaults", "全て", "Custom | settings"] });
  expect(shown).toEqual({ title: "Which settings?", options: ["Pi defaults", "全て", "Custom | settings", other] });
  expect(response.content).toEqual([{ type: "text", text: "全て" }]);
  expect(response.details).toEqual({ answer: "全て", choice: 2 });
});

test("Other opens free text, and Escape at either step is not an answer", async () => {
  const h = harness(); install(h.pi);
  h.ctx.ui.select = async () => other;
  h.ctx.ui.input = async (title: string) => `typed for ${title}`;
  expect((await h.call("ask_user", { question: "Q?", choices: ["A"] })).details).toEqual({ answer: "typed for Q?" });
  h.ctx.ui.input = async () => undefined;
  await expect(h.call("ask_user", { question: "Q?", choices: ["A"] })).rejects.toThrow("cancelled");
  h.ctx.ui.select = async () => undefined;
  await expect(h.call("ask_user", { question: "Q?", choices: ["A"] })).rejects.toThrow("cancelled");
});

test("choices cannot impersonate the Other entry", async () => {
  const h = harness(); install(h.pi);
  await expect(h.call("ask_user", { question: "Q?", choices: [other] })).rejects.toThrow("added automatically");
});
