import { compactionThreshold } from "../codex-compaction/settings.ts";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { convertToLlm, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { result, restore } from "../../lib/common.ts";
import { minimaxEnabled, minimaxKey } from "../../lib/minimax.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";
import { Archive, archiveMessages, type Artifact } from "./archive.ts";
import { modeTools, companionTool, allowedTool, registerTools } from "./tools.ts";

import { checkpointPrompt, checkpointControl, harnessPrompt } from "./prompts.ts";
import { Tasks } from "./tasks.ts";
import { installThresholdCompaction } from "./compaction.ts";

const archiveKey = "rework:minimax-archive";
const todoKey = "rework:minimax-todos";
const todosSchema = Type.Object({ todos: Type.Array(Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  content: Type.String({ minLength: 1, maxLength: 2000 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")]),
}), { maxItems: 100 }) });
type Todos = Static<typeof todosSchema>["todos"];
type Mode = { enabled: boolean };

export default function minimax(pi: ExtensionAPI, tasks = new Tasks()) {
  const archive = new Archive();
  let displaced: string[] = [];
  let applied = false;
  const artifacts = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().flatMap(entry =>
    entry.type === "custom" && entry.customType === archiveKey ? entry.data as Artifact[] : []);
  const todos = (ctx: ExtensionContext) => restore<Todos>(ctx, todoKey) ?? [];
  function apply(ctx: ExtensionContext) {
    let active = pi.getActiveTools();
    if (applied) active = [...new Set([...active.filter(name => !modeTools.includes(name)), ...displaced])];
    else active = active.filter(name => name === "read" || !modeTools.includes(name));
    const state = restore<Mode>(ctx, minimaxKey);
    applied = state?.enabled === true;
    displaced = applied ? active.filter(name => !companionTool(name) && name !== "archive_read") : [];
    if (applied) active = [...active.filter(companionTool), ...modeTools];
    // Retrieval remains available after disabling and after checkpoints containing IDs.
    pi.setActiveTools([...new Set([...active, "archive_read"])]);
    ctx.ui.setStatus("minimax", applied ? "minimax" : undefined);
  }
  registerTools(pi, tasks);
  installThresholdCompaction(pi);
  for (const event of ["session_start", "session_switch", "session_fork", "session_tree"] as const) pi.on(event, (_event, ctx) => apply(ctx));
  pi.registerCommand("minimax", {
    description: "Toggle MiniMax-style context and tools: [on|off]",
    async handler(args, ctx) {
      const value = args.trim();
      if (!["", "on", "off"].includes(value)) throw new Error("Usage: /minimax [on|off]");
      if (!ctx.isIdle()) throw new Error("Wait for the current run to finish before toggling MiniMax mode");
      const enabled = value ? value === "on" : !minimaxEnabled(ctx);
      pi.appendEntry(minimaxKey, { enabled });
      pi.events.emit("rework:minimax-changed", ctx);
      apply(ctx);
      ctx.ui.notify(`MiniMax mode ${enabled ? "on: context archiving, structured compaction, and tools" : "off"}`, "info");
    },
  });
  pi.on("tool_call", (event, ctx) => {
    if (minimaxEnabled(ctx) && !allowedTool(event.toolName)) return { block: true, reason: `${event.toolName} is unavailable in MiniMax mode. Use read, edit, write, bash, grep, glob, task_query, task_output, task_stop, todo_write, or archive_read.` };
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!minimaxEnabled(ctx)) return;
    pi.setActiveTools(pi.getActiveTools().filter(allowedTool));
    return { systemPrompt: `${event.systemPrompt}\n${harnessPrompt}\nCurrent stored todos:\n${JSON.stringify(todos(ctx))}` };
  });
  pi.on("context", async (event, ctx) => {
    if (!minimaxEnabled(ctx)) return;
    const projected = await archiveMessages(event.messages, artifacts(ctx), archive);
    if (projected.added.length) pi.appendEntry(archiveKey, projected.added);
    return { messages: projected.messages };
  });
  pi.registerTool({
    name: "todo_write", label: "Update task list", renderCall: toolCall("todo_write"), renderResult,
    description: "MiniMax mode only. Replace the stored task list. Persists across compaction. Use [] to clear. At most one item may be in progress. Does not create goals or trigger continuation.",
    parameters: todosSchema,
    async execute(_id, args, signal, _update, ctx) {
      if (!minimaxEnabled(ctx)) throw new Error("Enable /minimax before updating tasks");
      signal?.throwIfAborted();
      if (new Set(args.todos.map(todo => todo.id)).size !== args.todos.length) throw new Error("Todo IDs must be unique");
      if (args.todos.filter(todo => todo.status === "in_progress").length > 1) throw new Error("Only one todo may be in progress");
      pi.appendEntry(todoKey, args.todos);
      return result({ todos: args.todos });
    },
  });
  pi.registerTool({
    name: "archive_read", label: "Read archived output", renderCall: toolCall("archive_read"), renderResult,
    description: "Retrieve a bounded character range of an original tool-result JSON artifact by ID. Available even after MiniMax mode is disabled. Offsets count Unicode code points.",
    parameters: Type.Object({ id: Type.String({ pattern: "^[a-f0-9]{64}$" }), offset: Type.Integer({ minimum: 0 }), limit: Type.Integer({ minimum: 1, maximum: 32000 }) }),
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!artifacts(ctx).some(artifact => artifact.id === args.id)) throw new Error("Archive ID is not on this session branch");
      const chars = [...await archive.read(args.id)];
      const end = Math.min(args.offset + args.limit, chars.length);
      return result({ content: chars.slice(args.offset, end).join(""), total: chars.length, nextOffset: end < chars.length ? end : null });
    },
  });
  pi.on("session_before_compact", async (event, ctx) => {
    if (!minimaxEnabled(ctx)) return;
    const { preparation, signal } = event;
    // Do not let Pi's lower native threshold override /threshold. Overflow
    // recovery and explicit /compact are still allowed at any usage level.
    if (event.reason === "threshold" && preparation.tokensBefore < compactionThreshold(ctx)) return { cancel: true };
    try {
      if (!ctx.model) throw new Error("Select a model before compacting");
      const projected = await archiveMessages([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages], artifacts(ctx), archive);
      if (projected.added.length) pi.appendEntry(archiveKey, projected.added);
      const response = await ctx.modelRegistry.complete(ctx.model, {
        systemPrompt: checkpointPrompt,
        messages: [
          { role: "user", timestamp: Date.now(), content: `Previous checkpoint:\n${preparation.previousSummary ?? "none"}\nConversation:\n${serializeConversation(convertToLlm(projected.messages))}` },
          { role: "user", timestamp: Date.now(), content: checkpointControl(event.customInstructions) },
        ],
      }, { signal, maxTokens: Math.min(8192, ctx.model.maxTokens), cacheRetention: "none", sessionId: randomUUID() });
      signal.throwIfAborted();
      if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") throw new Error(`Checkpoint generation stopped: ${response.stopReason}`);
      const summary = response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      if (!summary.trim()) throw new Error("Empty checkpoint");
      const taskState = todos(ctx);
      return { compaction: {
        summary: `${summary}\n\n## Host-stored todos (assistant-maintained, not independently verified)\n${JSON.stringify(taskState)}`,
        firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
        usage: response.usage, details: { minimax: true, todos: taskState },
      } };
    } catch (error) {
      ctx.ui.notify(`MiniMax compaction cancelled: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return { cancel: true };
    }
  });
}
