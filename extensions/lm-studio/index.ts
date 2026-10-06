import { createProvider, type Model, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const providerId = "lm-studio";

type StudioModel = {
  type: string;
  key: string;
  display_name?: string;
  max_context_length?: number;
  loaded_instances?: { id: string; config?: { context_length?: number } }[];
  capabilities?: { vision?: boolean; reasoning?: { allowed_options?: string[] } };
};

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function reasoningSupport(allowedOptions: string[] | undefined): {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
} {
  const options = new Set(Array.isArray(allowedOptions) ? allowedOptions : []);
  const reasoning = ["on", "low", "medium", "high"].some(option => options.has(option));
  if (!reasoning) return { reasoning: false };
  return {
    reasoning: true,
    thinkingLevelMap: {
      off: options.has("off") ? "none" : null,
      minimal: null,
      low: options.has("low") ? "low" : null,
      medium: options.has("medium") ? "medium" : null,
      // Binary reasoning has one enabled state, represented by Pi's high level.
      high: options.has("high") || options.has("on") ? "high" : null,
      xhigh: null,
      max: null,
    },
  };
}

function chatModels(data: unknown, baseUrl: string): Model<"openai-completions">[] {
  if (!data || typeof data !== "object" || !("models" in data) || !Array.isArray(data.models)) {
    throw new Error("LM Studio returned an invalid model catalog.");
  }
  const models = new Map<string, Model<"openai-completions">>();
  for (const entry of data.models) {
    if (!entry || typeof entry !== "object" || entry.type !== "llm") continue;
    const model = entry as StudioModel;
    if (typeof model.key !== "string" || !model.key.trim()) throw new Error("LM Studio returned a model without a key.");
    const reasoning = reasoningSupport(model.capabilities?.reasoning?.allowed_options);
    const instances = Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
    const targets = instances.length ? instances : [{ id: model.key }];
    for (const instance of targets) {
      if (typeof instance.id !== "string" || !instance.id.trim()) throw new Error("LM Studio returned an invalid instance ID.");
      const contextWindow = positiveInteger(instance.config?.context_length) ? instance.config.context_length
        : positiveInteger(model.max_context_length) ? model.max_context_length : 32768;
      models.set(instance.id, {
        id: instance.id,
        name: model.display_name || model.key,
        provider: providerId,
        api: "openai-completions",
        baseUrl,
        ...reasoning,
        input: model.capabilities?.vision === true ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: Math.min(8192, contextWindow),
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: reasoning.reasoning,
          maxTokensField: "max_tokens",
        },
      });
    }
  }
  return [...models.values()];
}

export function lmStudioProvider(
  baseUrl = process.env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1",
  apiKey = process.env.LM_STUDIO_API_KEY || "lm-studio",
): Provider<"openai-completions"> {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("LM_STUDIO_BASE_URL must be an HTTP(S) URL without credentials, a query, or a fragment.");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/v1$/, "")}/`;
  const catalogUrl = new URL("api/v1/models", url).href;
  const completionsUrl = new URL("v1", url).href;
  let models: Model<"openai-completions">[] = [];
  const provider = createProvider<"openai-completions">({
    id: providerId,
    name: "LM Studio",
    baseUrl: completionsUrl,
    models: [],
    auth: { apiKey: {
      name: "LM Studio local server",
      resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key || apiKey }, source: "LM Studio" }),
    } },
    api: openAICompletionsApi(),
  });
  return {
    ...provider,
    getModels: () => models,
    getAllModels: () => models,
    async refreshModels(context) {
      if (!context.allowNetwork || context.signal.aborted) return;
      const response = await fetch(catalogUrl, {
        headers: { Authorization: `Bearer ${context.credential?.type === "api_key" ? context.credential.key || apiKey : apiKey}` },
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(3000)]),
      });
      if (!response.ok) throw new Error(`LM Studio model discovery failed (HTTP ${response.status}). Check the local server and LM_STUDIO_API_KEY.`);
      const next = chatModels(await response.json(), completionsUrl);
      if (!context.signal.aborted) await context.publish({ update: () => { models = next; } });
    },
  };
}

export default async function lmStudio(pi: ExtensionAPI) {
  const provider = lmStudioProvider();
  // Discover before startup model selection, but keep Pi usable when the server is off.
  try {
    await provider.refreshModels!({
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async publication => { publication.update?.(); return true; },
    });
  } catch { /* /lm-studio reports connection errors on demand. */ }
  pi.registerProvider(provider);
  pi.registerCommand("lm-studio", {
    description: "Refresh local LM Studio models",
    async handler(_args, ctx) {
      const result = await ctx.modelRegistry.refresh({ providers: [providerId], force: true });
      const error = result.errors.get(providerId);
      if (error || result.aborted) {
        ctx.ui.notify(error?.message || "LM Studio model refresh canceled.", "error");
        return;
      }
      const available = ctx.modelRegistry.getAll().filter(model => model.provider === providerId);
      ctx.ui.notify(available.length
        ? `LM Studio: ${available.length} chat model(s). Select one with /model.\n${available.map(model => model.id).join("\n")}`
        : "LM Studio has no chat models. Download a model in LM Studio, then run /lm-studio again.", "info");
    },
  });
}
