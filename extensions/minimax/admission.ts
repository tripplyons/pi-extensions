import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi exposes the final payload hook, but no public dry-run serializer/tokenizer.
// Measure the LLM projection, not session details or historical usage totals.
export function footprint(messages: AgentMessage[]) {
  const llm = convertToLlm(messages);
  const payload = llm.map(message => message.role === "toolResult"
    ? { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, content: message.content, isError: message.isError }
    : { role: message.role, content: message.content });
  return { tokens: llm.reduce((sum, message) => sum + estimateTokens(message), 0), bytes: Buffer.byteLength(JSON.stringify(payload)) };
}

export function admitsArchive(before: AgentMessage[], after: AgentMessage[]) {
  const original = footprint(before), projected = footprint(after);
  return projected.tokens < original.tokens && projected.bytes < original.bytes;
}

export function requestTokens(messages: AgentMessage[], pi: ExtensionAPI, ctx: ExtensionContext) {
  const active = new Set(pi.getActiveTools());
  const tools = pi.getAllTools().filter(tool => active.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
  // Use Pi's root export: its extension loader does not supply pi-ai utils subpaths.
  const overhead = estimateTokens({ role: "user", content: ctx.getSystemPrompt(), timestamp: 0 }) +
    estimateTokens({ role: "user", content: JSON.stringify(tools), timestamp: 0 });
  return footprint(messages).tokens + overhead;
}

export function admitsReminder(messages: AgentMessage[], pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!ctx.model || !Number.isFinite(ctx.model.contextWindow) || ctx.model.contextWindow <= 0 || !Number.isFinite(ctx.model.maxTokens) || ctx.model.maxTokens <= 0) return false;
  const reserve = Math.min(ctx.model.maxTokens, 16384);
  // Leave a margin for provider framing and tokenizer differences. This is an
  // estimate, not a guarantee that the provider will accept the request.
  return requestTokens(messages, pi, ctx) + reserve < ctx.model.contextWindow * 0.9;
}
