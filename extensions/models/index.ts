import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

export default function models(pi: ExtensionAPI) {
  pi.registerCommand("models", {
    description: "List available models or select an exact provider/model ID",
    async handler(args, ctx) {
      const available = ctx.modelRegistry.getAvailable();
      const id = args.trim();
      if (!id) {
        ctx.ui.notify(available.map(model => `${model.provider}/${model.id}${ctx.model?.provider === model.provider && ctx.model.id === model.id ? " *" : ""}`).join("\n") || "No authenticated models available", "info");
        return;
      }
      const model = available.find(model => `${model.provider}/${model.id}` === id);
      if (!model) throw new Error(`Unavailable model: ${id}. Use /models to list authenticated models.`);
      if (!await pi.setModel(model)) throw new Error(`Could not select ${id}; check provider authentication.`);
      ctx.ui.notify(`Model ${id}`, "info");
    },
  });
  for (const name of ["reasoning", "thinking", "effort"]) pi.registerCommand(name, {
    description: "Show or set the current model's supported reasoning effort",
    async handler(args, ctx) {
      if (!ctx.model) throw new Error("No model selected");
      const supported = getSupportedThinkingLevels(ctx.model);
      const value = args.trim().toLowerCase();
      if (!value) {
        ctx.ui.notify(`Reasoning ${pi.getThinkingLevel()} · supported: ${supported.join(", ")}`, "info");
        return;
      }
      const level = supported.find(level => level === value);
      if (!level) throw new Error(`Unsupported reasoning effort: ${value}. Supported: ${supported.join(", ")}`);
      pi.setThinkingLevel(level);
      ctx.ui.notify(`Reasoning ${pi.getThinkingLevel()}`, "info");
    },
  });
}
