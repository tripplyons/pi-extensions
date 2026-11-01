import { toolCall } from "../../lib/tool-preview.ts";
import { askQuestion } from "./dialog.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { text } from "../../lib/common.ts";

export const other = "Other (type an answer)";

// PI_ASK_USER_TIMEOUT sets the wait in seconds; 0 waits until answered.
// pi-desk sets 0 because its questions are answered from an inbox, often hours later.
export function timeoutMs(env = process.env.PI_ASK_USER_TIMEOUT): number | undefined {
  if (env === undefined || env.trim() === "") return 600_000;
  const seconds = Number(env);
  if (!Number.isFinite(seconds) || seconds < 0) return 600_000;
  return seconds === 0 ? undefined : seconds * 1000;
}

export default function askUser(pi: ExtensionAPI) {
  let pending = false;
  pi.registerTool({
    renderCall: toolCall("ask_user"),
    name: "ask_user", label: "Ask user",
    description: "Ask one question and wait for an answer. Supply choices or []; the user picks one or types free text, and a picked choice returns its text. Optionally set recommended to the 1-based number of the choice you recommend. Do not request secrets. Call alone, not in parallel. Workers must ask their parent. Times out after ten minutes unless configured otherwise; cancellation is not an answer.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 2000 }),
      choices: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 8 }),
      recommended: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "1-based number of the recommended choice" })),
    }),
    async execute(_id, args, signal, _update, ctx) {
      if (process.env.PI_SWARM_NODE) throw new Error("Workers must ask their parent with swarm_send");
      if (!ctx.hasUI) throw new Error("ask_user requires an interactive Pi UI");
      if (pending) throw new Error("Another question is pending");
      text(args.question, "question", 2000);
      args.choices.forEach(choice => text(choice, "choice", 200));
      // Select returns the label, so a matching choice would be indistinguishable.
      if (args.choices.includes(other)) throw new Error(`Choices must not include "${other}"; it is added automatically`);
      if (args.recommended !== undefined && args.recommended > args.choices.length) throw new Error("recommended must be the number of one of the choices");
      signal?.throwIfAborted();
      pending = true;
      pi.events.emit("pi:prompt", true);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const wait = timeoutMs();
      const timer = wait === undefined ? undefined : setTimeout(abort, wait);
      try {
        const cancelled = () => new Error("Question cancelled or timed out; no answer received");
        if (args.choices.length) {
          const picked = await askQuestion(ctx, args.question, [...args.choices, other], controller.signal, args.recommended && args.recommended - 1);
          if (controller.signal.aborted || picked === undefined) throw cancelled();
          if (picked !== other) return { content: [{ type: "text", text: picked }], details: { answer: picked, choice: args.choices.indexOf(picked) + 1 } };
        }
        const answer = await askQuestion(ctx, args.question, [], controller.signal);
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
