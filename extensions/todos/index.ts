import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { result, restore } from "../../lib/common.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";

// Keep the session key so existing branches retain their task lists.
export const todoKey = "pi:minimax-todos";

const todosSchema = Type.Object({ todos: Type.Array(Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  content: Type.String({ minLength: 1, maxLength: 2000 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")]),
}), { maxItems: 100 }) });
type Todos = Static<typeof todosSchema>["todos"];

export default function todos(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const todos = restore<Todos>(ctx, todoKey) ?? [];
    event.systemPromptOptions.sections.todos = `Use todo_write for multi-step task tracking, not goal creation. Stored todos are assistant-maintained state, not proof of completion.\nCurrent stored todos:\n${JSON.stringify(todos)}`;
  });
  pi.registerTool({
    name: "todo_write", label: "Update task list", renderCall: toolCall("todo_write"), renderResult,
    description: "Replace the stored task list. Persists across compaction. Use [] to clear. At most one item may be in progress. Does not create goals or trigger continuation.",
    parameters: todosSchema,
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      if (new Set(args.todos.map(todo => todo.id)).size !== args.todos.length) throw new Error("Todo IDs must be unique");
      if (args.todos.filter(todo => todo.status === "in_progress").length > 1) throw new Error("Only one todo may be in progress");
      pi.appendEntry(todoKey, args.todos);
      return result({ todos: args.todos });
    },
  });
}
