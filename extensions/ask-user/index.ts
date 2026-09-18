import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { text } from "../../lib/common.ts";

export default function askUser(pi: ExtensionAPI) {
  let pending = false;
  pi.registerTool({
    name: "ask_user", label: "Ask user",
    description: "Ask one question and wait for free text. Supply suggestions or []. Do not request secrets. Call alone, not in parallel. Workers must ask their parent. Times out after ten minutes; cancellation is not an answer.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 2000 }),
      choices: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 8 }),
    }),
    async execute(_id, args, signal, _update, ctx) {
      if (process.env.PI_SWARM_NODE) throw new Error("Workers must ask their parent with swarm_send");
      if (!ctx.hasUI) throw new Error("ask_user requires an interactive Pi UI");
      if (pending) throw new Error("Another question is pending");
      text(args.question, "question", 2000);
      args.choices.forEach(choice => text(choice, "choice", 200));
      signal?.throwIfAborted();
      pending = true;
      pi.events.emit("rework:prompt", true);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 600_000);
      try {
        const title = args.question + (args.choices.length ? `\n\nSuggestions:\n${args.choices.map((choice, index) => `${index + 1}. ${choice}`).join("\n")}` : "");
        const answer = await ctx.ui.input(title, "Free-text answer", { signal: controller.signal });
        if (controller.signal.aborted || answer === undefined) throw new Error("Question cancelled or timed out; no answer received");
        return { content: [{ type: "text", text: answer }], details: { answer } };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        pending = false;
        pi.events.emit("rework:prompt", false);
      }
    },
  });
}
