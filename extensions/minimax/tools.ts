import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createReadTool, createEditTool, createWriteTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerSearchTools } from "./search.ts";
import { registerTaskTools, type Tasks } from "./tasks.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";

// Native details contain truncation metadata, not the payload shown by our previews.
const renderFileResult: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme, context) => {
  const diff = (result.details as { diff?: string } | undefined)?.diff;
  const content = !context.isError && diff
    ? [...result.content, { type: "text" as const, text: diff }]
    : result.content;
  return renderResult({ ...result, content, details: undefined }, options, theme, context);
};

const factories = {
  edit: createEditTool,
  write: createWriteTool,
};
export const harnessTools = ["read", ...Object.keys(factories), "grep", "glob", "bash", "task_query", "task_output", "task_stop", "todo_write"];
export const companionTool = (name: string) => name.startsWith("swarm_") ||
  ["ask_user", "complain", "create_goal", "get_goal", "update_goal", "init_experiment", "run_experiment", "log_experiment"].includes(name);
export const allowedTool = (name: string) => harnessTools.includes(name) || name === "archive_read" || companionTool(name);

export function registerTools(pi: ExtensionAPI, tasks?: Tasks) {
  pi.registerTool(readTool(process.cwd()));
  registerTaskTools(pi, tasks);
  registerSearchTools(pi);
  for (const [name, create] of Object.entries(factories)) {
    const tool = create(process.cwd());
    pi.registerTool({
      name, label: name, description: tool.description,
      parameters: tool.parameters, renderCall: toolCall(name), renderResult: renderFileResult,
      async execute(id, args, signal, update, ctx) {
        signal?.throwIfAborted();
        return create(ctx.cwd).execute(id, args, signal, update);
      },
    });
  }
}

export function readTool(cwd: string): ToolDefinition<ReturnType<typeof createReadTool>["parameters"]> {
  const tool = createReadTool(cwd);
  return {
    name: "read", label: "Read", description: tool.description, parameters: tool.parameters,
    renderCall: toolCall("read"), renderResult: renderFileResult,
    async execute(id, args, signal, update, ctx) {
      signal?.throwIfAborted();
      for (const value of [args.offset, args.limit]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Read offset and limit must be positive line counts");
      if (!(await stat(resolve(ctx.cwd, args.path))).isFile()) throw new Error("Not a regular file");
      return createReadTool(ctx.cwd).execute(id, args, signal, update);
    },
  };
}
