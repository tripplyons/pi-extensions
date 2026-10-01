import {
  createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema } from "typebox";
import { toolCall } from "../../lib/tool-preview.ts";

// Public factories retain native schemas, execution, and result contracts.
// Only the streamed call title changes.
export function registerNativeToolRenderers(pi: ExtensionAPI) {
  function register<T extends TSchema, D>(create: (cwd: string) => ToolDefinition<T, D>) {
    const original = create(process.cwd());
    pi.registerTool({
      ...original,
      execute: (id, args, signal, update, ctx) => create(ctx.cwd).execute(id, args, signal, update, ctx),
      renderCall: toolCall(original.name),
    });
  }
  register(createReadToolDefinition);
  register(createEditToolDefinition);
  register(createWriteToolDefinition);
  register(createGrepToolDefinition);
  register(createFindToolDefinition);
  register(createLsToolDefinition);
}
