import { toolCall } from "../../lib/tool-preview.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { text } from "../../lib/common.ts";

export const other = "Other (type an answer)";

export default function askUser(pi: ExtensionAPI) {
  let pending = false;
  pi.registerTool({
    renderCall: toolCall("ask_user"),
    name: "ask_user", label: "Ask user",
    description: "Ask one question and wait for an answer. Supply choices or []; the user picks one or types free text, and a picked choice returns its text. Do not request secrets. Call alone, not in parallel. Workers must ask their parent. Times out after ten minutes; cancellation is not an answer.",
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
      // Select returns the label, so a matching choice would be indistinguishable.
      if (args.choices.includes(other)) throw new Error(`Choices must not include "${other}"; it is added automatically`);
      signal?.throwIfAborted();
      pending = true;
      pi.events.emit("pi:prompt", true);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 600_000);
      try {
        const cancelled = () => new Error("Question cancelled or timed out; no answer received");
        if (args.choices.length) {
          const picked = await ctx.ui.select(args.question, [...args.choices, other], { signal: controller.signal });
          if (controller.signal.aborted || picked === undefined) throw cancelled();
          if (picked !== other) return { content: [{ type: "text", text: picked }], details: { answer: picked, choice: args.choices.indexOf(picked) + 1 } };
        }
        const answer = await ctx.ui.input(args.question, "Free-text answer", { signal: controller.signal });
        if (controller.signal.aborted || answer === undefined) throw cancelled();
        return { content: [{ type: "text", text: answer }], details: { answer } };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        pending = false;
        pi.events.emit("pi:prompt", false);
      }
    },
  });
}
