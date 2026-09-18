import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createReadTool, createEditTool, createWriteTool, createBashTool, createGrepTool, createFindTool, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { minimaxEnabled } from "../../lib/minimax.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";

const factories = {
  edit: createEditTool,
  write: createWriteTool,
  bash: createBashTool,
  grep: createGrepTool,
  glob: createFindTool,
};
export const modeTools = ["read", ...Object.keys(factories), "todo_write"];
export const companionTool = (name: string) => name.startsWith("swarm_") ||
  ["create_goal", "get_goal", "update_goal", "init_experiment", "run_experiment", "log_experiment"].includes(name);
export const allowedTool = (name: string) => modeTools.includes(name) || name === "archive_read" || companionTool(name);

export function registerTools(pi: ExtensionAPI) {
  for (const [name, create] of Object.entries(factories)) {
    const tool = create(process.cwd());
    pi.registerTool({
      name, label: name, description: `MiniMax mode only. ${tool.description}`,
      parameters: tool.parameters, renderCall: toolCall(name), renderResult,
      async execute(id, args, signal, update, ctx) {
        if (!minimaxEnabled(ctx)) throw new Error("Enable /minimax before using this tool");
        signal?.throwIfAborted();
        return create(ctx.cwd).execute(id, args, signal, update);
      },
    });
  }
}

// The files extension owns read, so it switches its definition without registering
// a competing tool under the same name.
export function modeReadTool(cwd: string): ToolDefinition<ReturnType<typeof createReadTool>["parameters"]> {
  const tool = createReadTool(cwd);
  return {
    name: "read", label: "Read", description: tool.description, parameters: tool.parameters,
    renderCall: toolCall("read"), renderResult,
    async execute(id, args, signal, update, ctx) {
      signal?.throwIfAborted();
      for (const value of [args.offset, args.limit]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Read offset and limit must be positive line counts");
      if (!(await stat(resolve(ctx.cwd, args.path))).isFile()) throw new Error("Not a regular file");
      return createReadTool(ctx.cwd).execute(id, args, signal, update);
    },
  };
}
