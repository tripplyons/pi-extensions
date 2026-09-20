import { compactionThreshold, registerThreshold } from "./settings.ts";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext, convertToLlm, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { result, restore } from "../../lib/common.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";
import { admitsArchive, admitsReminder, requestTokens } from "./admission.ts";
import { todoKey, todoReminderKey, loopReminderKey, staleTodos, todoReminder, loopReminder } from "./reminders.ts";
import { Archive, archiveMessages, capToolOutput, type Artifact } from "./archive.ts";
import { harnessTools, companionTool, allowedTool, registerTools } from "./tools.ts";

import { checkpointPrompt, checkpointControl, harnessPrompt } from "./prompts.ts";
import { Tasks } from "./tasks.ts";
import { installThresholdCompaction } from "./compaction.ts";

const archiveKey = "rework:minimax-archive";

const todosSchema = Type.Object({ todos: Type.Array(Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  content: Type.String({ minLength: 1, maxLength: 2000 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")]),
}), { maxItems: 100 }) });
type Todos = Static<typeof todosSchema>["todos"];

export default function minimax(pi: ExtensionAPI, tasks = new Tasks()) {
  const archive = new Archive();
  const artifacts = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().flatMap(entry =>
    entry.type === "custom" && entry.customType === archiveKey ? entry.data as Artifact[] : []);
  const todos = (ctx: ExtensionContext) => restore<Todos>(ctx, todoKey) ?? [];
  function apply() {
    pi.setActiveTools([...new Set([...pi.getActiveTools().filter(companionTool), ...harnessTools, "archive_read"])]);
  }
  registerTools(pi, tasks);
  async function project(messages: AgentMessage[], ctx: ExtensionContext) {
    const projected = await archiveMessages(messages, artifacts(ctx), archive, admitsArchive);
    if (projected.added.length) pi.appendEntry(archiveKey, projected.added);
    return projected.messages;
  }
  async function archiveFits(ctx: ExtensionContext, messages = buildSessionContext(ctx.sessionManager.getBranch()).messages) {
    const projected = await project(messages, ctx);
    // Only receipts actually present in this context justify bypassing Pi's
    // usage-based trigger. Full history, including retained messages, must fit.
    const ids = new Set(artifacts(ctx).map(artifact => artifact.toolCallId));
    return projected.some(message => message.role === "toolResult" && ids.has(message.toolCallId) &&
      message.content.some(block => block.type === "text" && block.text.includes("[minimax archive "))) &&
      admitsReminder(projected, pi, ctx) && requestTokens(projected, pi, ctx) < compactionThreshold(ctx);
  }
  registerThreshold(pi);
  installThresholdCompaction(pi, archiveFits);
  pi.on("tool_result", async (event, ctx) => {
    try {
      const capped = await capToolOutput({ role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName,
        content: event.content, details: event.details, isError: event.isError, timestamp: Date.now() }, archive);
      if (!capped) return;
      pi.appendEntry(archiveKey, [capped.artifact]);
      return { content: capped.output.content };
    } catch (error) {
      ctx.ui.notify(`MiniMax output archive failed; keeping original output: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
  for (const event of ["session_start", "session_switch", "session_fork", "session_tree"] as const) pi.on(event, apply);
  pi.on("tool_call", (event) => {
    if (!allowedTool(event.toolName)) return { block: true, reason: `${event.toolName} is unavailable in this harness. Use read, edit, write, bash, grep, glob, task_query, task_output, task_stop, todo_write, archive_read, or the existing ask_user.` };
  });
  pi.on("before_agent_start", (event, ctx) => {
    pi.setActiveTools(pi.getActiveTools().filter(allowedTool));
    return { systemPrompt: `${event.systemPrompt}\n${harnessPrompt}\nCurrent stored todos:\n${JSON.stringify(todos(ctx))}` };
  });
  pi.on("context", async (event, ctx) => {
    let messages = await project(event.messages, ctx);
    if (ctx.signal?.aborted) return { messages };
    const loop = loopReminder(event.messages);
    const pending = todos(ctx).some(todo => todo.status === "pending" || todo.status === "in_progress");
    const reminders = [
      ...(loop && restore<string>(ctx, loopReminderKey) !== loop.id ? [{ key: loopReminderKey, data: loop.id, content: loop.content }] : []),
      ...(pending && pi.getActiveTools().includes("todo_write") && staleTodos(ctx) ? [{ key: todoReminderKey, data: true, content: todoReminder }] : []),
    ];
    for (const reminder of reminders) {
      const candidate = [...messages, { role: "custom" as const, customType: reminder.key, content: reminder.content, display: false, timestamp: Date.now() }];
      if (!admitsReminder(candidate, pi, ctx)) continue;
      messages = candidate;
      pi.appendEntry(reminder.key, reminder.data);
    }
    return { messages };
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
  pi.registerTool({
    name: "archive_read", label: "Read archived output", renderCall: toolCall("archive_read"), renderResult,
    description: "Retrieve a bounded character range of an original tool-result JSON artifact by ID. Offsets count Unicode code points.",
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
    const { preparation, signal } = event;
    // Do not let Pi's lower native threshold override /threshold. Overflow
    // recovery and explicit /compact are still allowed at any usage level.
    if (event.reason === "threshold" && preparation.tokensBefore < compactionThreshold(ctx)) return { cancel: true };
    try {
      if (!ctx.model) throw new Error("Select a model before compacting");
      if (event.reason === "threshold" && !event.customInstructions && await archiveFits(ctx)) return { cancel: true };
      const projected = await archiveMessages([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages], artifacts(ctx), archive, admitsArchive);
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
