import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { result, restore } from "../../lib/common.ts";

type Call = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type Output = Extract<AgentMessage, { role: "toolResult" }>;
type Archived = { call: Call; output: Output; pruneCall: boolean; pruneOutput: boolean };
type State = { enabled: boolean; serial: number; archive: Record<string, Archived> };
const key = "rework:pruner";
const marker = "[context-pruner]";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const large = (value: unknown) => bytes(value) > 250 && !JSON.stringify(value).includes(marker);

export function prune(messages: AgentMessage[], state: State, force: boolean) {
  const copy = structuredClone(messages);
  const calls = new Map<string, { call: Call; index: number }>();
  for (const [index, message] of copy.entries()) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, { call: block, index });
  }
  // Reapply persisted projections. The source session messages are never changed.
  for (const [id, entry] of Object.entries(state.archive)) {
    const call = calls.get(entry.call.id)?.call;
    if (call && entry.pruneCall) call.arguments = { _pruned: `${marker} Use tool_pruner_view: ${id}` };
    const output = copy.find(message => message.role === "toolResult" && message.toolCallId === entry.call.id) as Output | undefined;
    if (output && entry.pruneOutput) output.content = [{ type: "text", text: `${marker} Archived; use tool_pruner_view with {"ids":["${id}"]}.` }];
  }
  const eligible: { call: Call; index: number; output: Output; pruneCall: boolean; pruneOutput: boolean }[] = [];
  const completed = new Set<string>();
  for (const message of copy) {
    if (message.role !== "toolResult") continue;
    completed.add(message.toolCallId);
    const found = calls.get(message.toolCallId);
    if (!found || found.call.name === "tool_pruner_view") continue;
    const skill = found.call.name === "read" && /(^|\/)SKILL\.md$/.test(String(found.call.arguments.path));
    const pruneCall = ["shell", "write", "edit"].includes(found.call.name) && large(found.call.arguments);
    const pruneOutput = !skill && large(message.content);
    if (pruneCall || pruneOutput) eligible.push({ ...found, output: message, pruneCall, pruneOutput });
  }
  const count = Math.max(0, eligible.length - 5);
  let boundary = copy.length;
  for (const entry of eligible.slice(count)) boundary = Math.min(boundary, entry.index);
  for (const entry of calls.values()) if (!completed.has(entry.call.id)) boundary = Math.min(boundary, entry.index);
  let reclaimable = 0;
  for (const entry of eligible.slice(0, count)) reclaimable += (entry.pruneCall ? bytes(entry.call.arguments) : 0) + (entry.pruneOutput ? bytes(entry.output.content) : 0);
  if (eligible.length >= 5) for (const message of copy.slice(0, boundary)) {
    if (message.role === "assistant") for (const block of message.content) if (block.type === "thinking") reclaimable += bytes(block);
  }
  if (!force && (!state.enabled || reclaimable < 50_000)) return { messages: copy, reclaimable, changed: false };
  for (const entry of eligible.slice(0, count)) {
    const id = `tp_${++state.serial}`;
    state.archive[id] = structuredClone(entry);
    if (entry.pruneCall) entry.call.arguments = { _pruned: `${marker} Use tool_pruner_view: ${id}` };
    if (entry.pruneOutput) entry.output.content = [{ type: "text", text: `${marker} Archived; use tool_pruner_view with {"ids":["${id}"]}.` }];
  }
  if (eligible.length >= 5) for (const message of copy.slice(0, boundary)) {
    if (message.role === "assistant") message.content = message.content.filter(block => block.type !== "thinking");
  }
  return { messages: copy.filter(message => message.role !== "assistant" || message.content.length > 0), reclaimable, changed: count > 0 };
}

export default function contextPruner(pi: ExtensionAPI) {
  let state: State = { enabled: false, serial: 0, archive: {} };
  let manual = false;
  const load = (_event: unknown, ctx: ExtensionContext) => {
    state = restore<State>(ctx, key) ?? { enabled: false, serial: 0, archive: {} };
    manual = false;
  };
  for (const event of ["session_start", "session_switch", "session_fork", "session_tree"] as const) pi.on(event, load);
  pi.registerCommand("prune", { description: "Prune old tool interactions on the next request", async handler(args, ctx) {
    if (args.trim()) throw new Error("Usage: /prune");
    manual = true;
    ctx.ui.notify("Pruning queued for the next model request", "info");
  } });
  pi.registerCommand("pruner", { description: "Toggle automatic context pruning: [on|off]", async handler(args, ctx) {
    if (!["", "on", "off"].includes(args.trim())) throw new Error("Usage: /pruner [on|off]");
    state.enabled = args.trim() ? args.trim() === "on" : !state.enabled;
    pi.appendEntry(key, state);
    ctx.ui.notify(`Automatic pruning ${state.enabled ? "on" : "off"}`, "info");
  } });
  pi.on("context", (event, ctx) => {
    const pruned = prune(event.messages, state, manual);
    manual = false;
    if (pruned.changed) pi.appendEntry(key, state);
    ctx.ui.setStatus("pruner", state.enabled || state.serial ? `${(pruned.reclaimable / 1000).toFixed(1)}/50 KB` : undefined);
    return { messages: pruned.messages };
  });
  pi.registerTool({
    name: "tool_pruner_view", label: "Retrieve archived interaction",
    description: "Retrieve one original tool call and result using its context-pruner marker ID.",
    parameters: Type.Object({ ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 1 }) }),
    async execute(_id, { ids }) {
      const entry = state.archive[ids[0]];
      if (!entry) throw new Error("Unknown pruned interaction ID");
      return result({ call: entry.call, output: entry.output });
    },
  });
}
