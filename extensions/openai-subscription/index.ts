import { lazyStream, type AnyModel, type AssistantMessageEvent, type Provider, type ProviderRequestOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const message = "OpenAI API billing is disabled. Use /login openai and Sign in with ChatGPT. API keys and paid OpenAI gateways are blocked.";

export function isOpenAI(model: Pick<AnyModel, "provider" | "id" | "baseUrl" | "api">) {
  return ["openai", "openai-codex", "azure-openai-responses"].includes(model.provider) ||
    /(?:^|\/)openai\//i.test(model.id) ||
    /^(?:gpt-(?!oss(?:-|$))|chatgpt-|o[134](?:-|$)|dall-e|codex-)/i.test(model.id) ||
    /(?:^|\.)(?:openai\.com|openai\.azure\.com)$/i.test(host(model.baseUrl));
}
function host(url: string) {
  try { return new URL(url).hostname; } catch { return ""; }
}
export function assertSubscription(model: AnyModel, options: ProviderRequestOptions<AnyModel> | undefined, tokens: ReadonlySet<string>) {
  if (!isOpenAI(model)) return;
  // Check resolved request auth, not the selected model or a stale auth status.
  // Explicit --api-key and configured Authorization headers cannot bypass it.
  const native = model.provider === "openai" && model.api === "openai-responses" &&
    model.baseUrl === "https://api.openai.com/v1";
  const codex = model.provider === "openai-codex" && model.api === "openai-codex-responses" &&
    model.baseUrl === "https://chatgpt.com/backend-api";
  if ((!native && !codex) || (!options?.apiKey || !tokens.has(options.apiKey))) throw new Error(message);
  for (const [name, value] of Object.entries({ ...model.headers, ...options?.headers })) {
    const key = name.toLowerCase();
    if (value !== null && (key === "authorization" && value !== `Bearer ${options?.apiKey}` ||
      ["api-key", "x-api-key", "openai-organization", "openai-project"].includes(key))) throw new Error(message);
  }
}

// Provider wrappers run before dispatch. Extension lifecycle hooks catch errors
// and continue, so throwing in before_provider_request is not a billing guard.
export async function* retryableStream(events: AsyncIterable<AssistantMessageEvent>): AsyncIterable<AssistantMessageEvent> {
  for await (const event of events) {
    if (event.type === "error" && event.reason === "error" &&
      event.error.errorMessage === "upstream stream ended before a completion event; this turn may be incomplete") {
      // Pi 1.0.1 recognizes connection errors, but not this Responses EOF text.
      // Keep the failed turn failed. Pi owns the retry budget and backoff.
      yield { ...event, error: { ...event.error, errorMessage: `Connection error: ${event.error.errorMessage}` } };
    } else yield event;
  }
}

export function guardProvider(provider: Provider): Provider {
  const tokens = new Set<string>();
  const oauth = provider.auth.oauth;
  return {
    ...provider,
    ...(provider.id === "openai" || provider.id === "openai-codex" ? {
      auth: {
        apiKey: { name: "OpenAI API billing blocked", check: async () => undefined,
          resolve: async input => {
            // Pi passes already-resolved OAuth tokens as apiKey when compacting.
            // Accept only tokens verified by this guard's OAuth resolver.
            const key = input.credential?.key;
            if (!key || !tokens.has(key)) throw new Error(message);
            return { auth: { apiKey: key }, source: "OAuth" };
          } },
        ...(oauth ? { oauth: { ...oauth, toAuth: async credential => {
          if (provider.id === "openai" && (!Array.isArray(credential.scopes) ||
            !credential.scopes.includes("chatgpt.tokens.use.direct"))) throw new Error(message);
          const auth = await oauth.toAuth(credential);
          if (!auth.apiKey || auth.apiKey.startsWith("sk-")) throw new Error(message);
          tokens.add(auth.apiKey);
          // Retain a few concurrent/rotated OAuth resolutions, never persist them.
          if (tokens.size > 8) tokens.delete(tokens.values().next().value!);
          return auth;
        } } } : {}),
      },
    } : {}),
    stream: (model, context, options) => lazyStream(model, async () => {
      assertSubscription(model, options, tokens);
      return retryableStream(provider.stream(model, context, options));
    }),
    streamSimple: (model, context, options) => lazyStream(model, async () => {
      assertSubscription(model, options, tokens);
      return retryableStream(provider.streamSimple(model, context, options));
    }),
    ...(provider.fetchDeferred ? { fetchDeferred: (model, handle, options) => lazyStream(model, async () => {
      assertSubscription(model, options, tokens);
      return retryableStream(provider.fetchDeferred!(model, handle, options));
    }) } : {}),
    ...(provider.cancelDeferred ? { cancelDeferred: async (model, handle, options) => {
      assertSubscription(model, options, tokens);
      return provider.cancelDeferred!(model, handle, options);
    } } : {}),
    ...(provider.generateImages ? { generateImages: async (model, context, options) => {
      assertSubscription(model, options, tokens);
      return provider.generateImages!(model, context, options);
    } } : {}),
    ...(provider.classify ? { classify: async (model, context, options) => {
      assertSubscription(model, options, tokens);
      return provider.classify!(model, context, options);
    } } : {}),
  };
}

export default function openaiSubscription(pi: ExtensionAPI) {
  const guarded = new Set<string>();
  // Cover gateways and configured providers, including non-chat operations.
  const install = (_event: unknown, ctx: ExtensionContext) => {
    for (const id of new Set([...ctx.modelRegistry.getAll(), ...ctx.modelRegistry.getModelsOfType("image"),
      ...ctx.modelRegistry.getModelsOfType("classifier")].map(model => model.provider))) {
      if (guarded.has(id)) continue;
      const provider = ctx.modelRegistry.getProvider(id);
      if (!provider) continue;
      pi.registerProvider(guardProvider(provider));
      guarded.add(id);
    }
  };
  pi.on("session_start", install);
  pi.on("before_agent_start", install);
}
