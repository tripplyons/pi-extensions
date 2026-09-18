import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
}
