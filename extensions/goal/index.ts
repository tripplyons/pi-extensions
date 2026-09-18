import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { result, restore, text } from "../../lib/common.ts";

type Goal = {
  objective: string;
  status: "active" | "paused" | "complete" | "blocked";
  createdAt: number;
  elapsedMs: number;
  tokens: number;
  continuations: number;
};
const key = "rework:goal";

export default function goals(pi: ExtensionAPI) {
  let goal: Goal | undefined;
  let activeSince: number | undefined;
  function account() {
    if (goal && activeSince !== undefined) goal.elapsedMs += Date.now() - activeSince;
    activeSince = goal?.status === "active" ? Date.now() : undefined;
  }
  function save(ctx: ExtensionContext) {
    account();
    pi.appendEntry(key, goal ?? null);
    ctx.ui.setStatus("goal", goal?.status === "active" ? "goal" : undefined);
  }
  function load(_event: unknown, ctx: ExtensionContext) {
    goal = restore<Goal | null>(ctx, key) ?? undefined;
    // Resuming a file never silently restarts an autonomous loop.
    if (goal?.status === "active") goal.status = "paused";
    activeSince = undefined;
    ctx.ui.setStatus("goal", undefined);
  }
  pi.on("session_start", load);
  pi.on("session_switch", load);
  pi.on("session_tree", load);
  pi.on("session_fork", load);
  pi.registerTool({
    name: "create_goal", label: "Create goal",
    description: "Create a goal only when the user explicitly requests one; never infer one from an ordinary task. Fails if an unfinished goal exists.",
    parameters: Type.Object({ objective: Type.String({ minLength: 1, maxLength: 4000 }) }),
    async execute(_id, args, _signal, _update, ctx) {
      if (goal && ["active", "paused"].includes(goal.status)) throw new Error("An unfinished goal already exists");
      goal = { objective: text(args.objective, "objective", 4000).trim(), status: "active", createdAt: Date.now(), elapsedMs: 0, tokens: 0, continuations: 0 };
      save(ctx);
      return result(goal);
    },
  });
  pi.registerTool({
    name: "get_goal", label: "Get goal", description: "Get the objective, status, active elapsed time, token usage, and continuation count.",
    parameters: Type.Object({}),
    async execute() { account(); return result(goal ?? null); },
  });
  pi.registerTool({
    name: "update_goal", label: "Finish goal",
    description: "Mark complete only after verifying the full objective. Mark blocked only after the same impasse repeats for at least three consecutive goal turns with no meaningful progress possible. Difficulty is not blocked. Only users may pause/resume.",
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]) }),
    async execute(_id, { status }, _signal, _update, ctx) {
      if (!goal || goal.status !== "active") throw new Error("No active goal");
      if (status === "blocked" && goal.continuations < 3) throw new Error("At least three continuation turns are required before blocked");
      account(); goal.status = status; activeSince = undefined; save(ctx);
      return result(goal);
    },
  });
  pi.registerCommand("goal", {
    description: "Goal: new <objective> | status | pause | resume | clear",
    async handler(args, ctx) {
      const [action = "status", ...words] = args.trim().split(/\s+/);
      if (action === "new") {
        if (goal && ["active", "paused"].includes(goal.status)) throw new Error("Clear or finish the existing goal first");
        goal = { objective: text(words.join(" "), "objective", 4000), status: "active", createdAt: Date.now(), elapsedMs: 0, tokens: 0, continuations: 0 };
      } else if (action === "clear") { account(); goal = undefined; }
      else if (action === "pause" || action === "resume") {
        if (!goal || !["active", "paused"].includes(goal.status)) throw new Error("No unfinished goal");
        account(); goal.status = action === "pause" ? "paused" : "active";
      } else if (action !== "status") throw new Error("Use /goal new <objective>, status, pause, resume, or clear");
      save(ctx);
      ctx.ui.notify(goal ? JSON.stringify(goal) : "No goal", "info");
      if ((action === "new" || action === "resume") && goal) pi.sendUserMessage(`Continue the explicitly requested goal: ${goal.objective}`, { deliverAs: "followUp" });
    },
  });
  pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\nCreate goals only on explicit user request. Verify the full objective before completion. Only users can pause/resume goals." }));
  pi.on("message_end", (event, ctx) => {
    if (!goal || goal.status !== "active" || event.message.role !== "assistant") return;
    goal.tokens += event.message.usage.totalTokens;
    if (["aborted", "error"].includes(event.message.stopReason)) { account(); goal.status = "paused"; }
    save(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    if (!goal || goal.status !== "active" || ctx.hasPendingMessages()) return;
    goal.continuations++;
    save(ctx);
    pi.sendUserMessage(`Continue the goal: ${goal.objective}\nCheck get_goal. Do not finish until the full objective is verified. If stuck, try a different approach; blocked requires the same impasse on at least three consecutive goal turns.`, { deliverAs: "followUp" });
  });
  pi.on("session_shutdown", (_event, ctx) => { if (goal?.status === "active") { account(); goal.status = "paused"; save(ctx); } });
}
