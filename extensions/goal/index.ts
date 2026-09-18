import { renderResult } from "../../lib/tool-preview.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
  function attached(ctx: ExtensionContext) {
    return Boolean(process.env.PI_SWARM_NODE || restore(ctx, "rework:swarm"));
  }
  function requireStandalone(ctx: ExtensionContext) {
    if (attached(ctx)) throw new Error("Finish or clear the attached swarm first");
  }
  pi.events.on("rework:swarm-attached", (ctx: ExtensionContext) => {
    if (goal?.status !== "active") return;
    account(); goal.status = "paused"; save(ctx);
  });
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
  pi.registerTool({ renderResult,
    name: "create_goal", label: "Create goal",
    description: "Create a goal only when the user explicitly requests one; never infer one from an ordinary task. Fails if an unfinished goal exists.",
    parameters: Type.Object({ objective: Type.String({ minLength: 1, maxLength: 4000 }) }),
    async execute(_id, args, _signal, _update, ctx) {
      requireStandalone(ctx);
      if (goal && ["active", "paused"].includes(goal.status)) throw new Error("An unfinished goal already exists");
      goal = { objective: text(args.objective, "objective", 4000).trim(), status: "active", createdAt: Date.now(), elapsedMs: 0, tokens: 0, continuations: 0 };
      save(ctx);
      return result(goal);
    },
  });
  pi.registerTool({ renderResult,
    name: "get_goal", label: "Get goal", description: "Get the objective, status, active elapsed time, token usage, and continuation count.",
    parameters: Type.Object({}),
    async execute() { account(); return result(goal ?? null); },
  });
  pi.registerTool({ renderResult,
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
  async function command(args: string, ctx: ExtensionCommandContext) {
      const [action = "status", ...words] = args.trim().split(/\s+/);
      if (action === "new" || action === "resume") requireStandalone(ctx);
      if (action === "new") {
        if (goal && ["active", "paused"].includes(goal.status)) throw new Error("Clear or finish the existing goal first");
        goal = { objective: text(words.join(" "), "objective", 4000), status: "active", createdAt: Date.now(), elapsedMs: 0, tokens: 0, continuations: 0 };
      } else if (action === "edit") {
        if (!goal) throw new Error("Create a goal before editing it");
        goal.objective = text(words.join(" "), "objective", 4000).trim();
      } else if (action === "clear") { account(); goal = undefined; }
      else if (action === "pause" || action === "resume") {
        if (!goal) throw new Error("No goal is currently set");
        account(); goal.status = action === "pause" ? "paused" : "active";
        if (action === "resume") goal.continuations = 0;
      } else if (action !== "status") throw new Error("Use /goal new <objective>, edit <objective>, status, pause, resume, or clear");
      save(ctx);
      ctx.ui.notify(goal ? JSON.stringify(goal) : "No goal", "info");
      if ((action === "new" || action === "resume") && goal) pi.sendUserMessage(`Continue the explicitly requested goal: ${goal.objective}`, { deliverAs: "followUp" });
  }
  pi.registerCommand("goal", {
    description: "Goal: new <objective> | edit <objective> | status | pause | resume | clear",
    handler: command,
  });
  for (const action of ["status", "edit", "pause", "resume", "clear"]) {
    pi.registerCommand(`goal:${action}`, {
      description: `Goal ${action}`,
      handler: (args, ctx) => command(`${action} ${args}`, ctx),
    });
  }
  pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\nCreate goals only on explicit user request. Verify the full objective before completion. Only users can pause/resume goals." }));
  pi.on("message_end", (event, ctx) => {
    if (!goal || goal.status !== "active" || event.message.role !== "assistant") return;
    goal.tokens += event.message.usage.totalTokens;
    if (["aborted", "error"].includes(event.message.stopReason)) { account(); goal.status = "paused"; }
    save(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    if (!goal || goal.status !== "active") return;
    if (attached(ctx)) { account(); goal.status = "paused"; save(ctx); return; }
    if (ctx.hasPendingMessages()) return;
    goal.continuations++;
    save(ctx);
    pi.sendUserMessage(`Continue the goal: ${goal.objective}\nCheck get_goal. Do not finish until the full objective is verified. If stuck, try a different approach; blocked requires the same impasse on at least three consecutive goal turns.`, { deliverAs: "followUp" });
  });
  pi.on("session_shutdown", (_event, ctx) => { if (goal?.status === "active") { account(); goal.status = "paused"; save(ctx); } });
}
