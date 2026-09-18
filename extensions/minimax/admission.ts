import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// Pi exposes the final payload hook, but no public dry-run serializer/tokenizer.
// Measure the LLM projection, not session details or historical usage totals.
export function footprint(messages: AgentMessage[]) {
  const llm = convertToLlm(messages);
  const payload = llm.map(message => message.role === "toolResult"
    ? { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, content: message.content, isError: message.isError }
    : { role: message.role, content: message.content });
  return { tokens: llm.reduce((sum, message) => sum + estimateMessageTokens(message), 0), bytes: Buffer.byteLength(JSON.stringify(payload)) };
}

export function admitsArchive(before: AgentMessage[], after: AgentMessage[]) {
  const original = footprint(before), projected = footprint(after);
  return projected.tokens < original.tokens && projected.bytes < original.bytes;
}

export function admitsReminder(messages: AgentMessage[], pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!ctx.model || !Number.isFinite(ctx.model.contextWindow) || ctx.model.contextWindow <= 0 || !Number.isFinite(ctx.model.maxTokens) || ctx.model.maxTokens <= 0) return false;
  const active = new Set(pi.getActiveTools());
  const tools = pi.getAllTools().filter(tool => active.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
  const overhead = estimateTextTokens(ctx.getSystemPrompt()) + estimateTextTokens(JSON.stringify(tools));
  const reserve = Math.min(ctx.model.maxTokens, 16384);
  // Leave a margin for provider framing and tokenizer differences. This is an
  // estimate, not a guarantee that the provider will accept the request.
  return footprint(messages).tokens + overhead + reserve < ctx.model.contextWindow * 0.9;
}
