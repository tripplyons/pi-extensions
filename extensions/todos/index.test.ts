import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import install, { todoKey } from "./index.ts";

test("todos validate writes, restore old branch state, and use a structured prompt section", async () => {
  const h = harness(); install(h.pi);
  const todos = [{ id: "check", content: "Check the native migration", status: "in_progress" }];
  await h.call("todo_write", { todos });
  expect(h.entries.at(-1)?.customType).toBe(todoKey);
  const event = { systemPrompt: "Base", systemPromptOptions: { sections: {} as Record<string, string> } };
  await h.emit("before_agent_start", event);
  expect(event.systemPrompt).toBe("Base");
  expect(event.systemPromptOptions.sections.todos).toContain("Check the native migration");
  await expect(h.call("todo_write", { todos: [...todos, todos[0]] })).rejects.toThrow("unique");
  await expect(h.call("todo_write", { todos: [...todos, { ...todos[0], id: "other" }] })).rejects.toThrow("one todo");
  await h.call("todo_write", { todos: [] });
  await h.emit("before_agent_start", event);
  expect(event.systemPromptOptions.sections.todos).toEndWith("[]");
});
