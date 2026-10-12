import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { priorityPayload } from "../extensions/fast-mode/index.ts";

// Small helper requests use GPT 6 Luna with low reasoning and priority service.
export function lunaModel(ctx: ExtensionContext) {
  return ["openai", "openai-codex"]
    .map(provider => ctx.modelRegistry.find(provider, "gpt-6-luna"))
    .find(model => model && ctx.modelRegistry.hasConfiguredAuth(model));
}

// Keep these nested requests out of the provider's live agent session.
export async function completeLuna(
  ctx: ExtensionContext,
  context: Context,
  options: { maxTokens: number; signal?: AbortSignal },
): Promise<AssistantMessage> {
  const model = lunaModel(ctx);
  if (!model) throw new Error("This request requires gpt-6-luna with OpenAI authentication. Use /login and check /model.");
  if (!ctx.modelRegistry.getProvider(model.provider)) throw new Error(`No provider registered for "${model.provider}"`);
  const stream = ctx.modelRegistry.streamSimple(model, context, {
    ...options,
    reasoning: "low",
    cacheRetention: "none",
    onPayload: (payload, physical) => priorityPayload(payload, physical.provider, true),
  });
  let response: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") response = event.message;
    if (event.type === "error") response = event.error;
  }
  if (!response) throw new Error("Request ended without a terminal result");
  return response;
}
