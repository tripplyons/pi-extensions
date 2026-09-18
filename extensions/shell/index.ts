import { renderSleepCall, renderSleepResult } from "./sleep-preview.ts";
import { renderCall } from "./command-preview.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve, join } from "node:path";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { result, stateRoot } from "../../lib/common.ts";
import { Jobs } from "./jobs.ts";
export default function shell(pi: ExtensionAPI) {
  const disableBash = () => {
    pi.setActiveTools(pi.getActiveTools().filter(name => name !== "bash"));
  };
  pi.on("session_start", disableBash);
  pi.on("session_switch", disableBash);
  pi.on("before_agent_start", disableBash);
  const jobs = new Jobs(join(stateRoot(), "jobs"));
  let activity = 0;
  pi.events.on("rework:swarm-activity", () => { activity++; });
  pi.on("input", () => { activity++; });
  pi.registerTool({ renderCall, renderResult, name: "shell", label: "Shell", description: "Run zsh in a tmux PTY. timeout is foreground grace, not a kill deadline. Returns a persistent job ID when still running. Cancellation kills the foreground job. Supports outside-workspace cwd.",
    parameters: Type.Object({ command: Type.String({ minLength: 1 }), cwd: Type.String(), timeout: Type.Number({ minimum: 0.1, maximum: 300 }), max_output_bytes: Type.Integer({ minimum: 1, maximum: 1048576 }) }),
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      const job = await jobs.start(ctx.sessionManager.getSessionId(), resolve(ctx.cwd, args.cwd), args.command);
      try { await jobs.wait(job, args.timeout, signal); }
      catch (error) { await jobs.kill(job); throw error; }
      const output = await jobs.output(job, args.max_output_bytes);
      return result({ ...output, background: output.status === "running" });
    } });
  pi.registerTool({ renderCall: toolCall("bg_process"), renderResult, name: "bg_process", label: "Background jobs", description: "Manage persistent shell jobs. Current session by default; scope=all explicitly permits foreign jobs. Actions: list, output, write PTY input, kill, clear finished jobs. end=true sends EOF.",
    parameters: Type.Object({ action: Type.Union(["list", "output", "write", "kill", "clear"].map(Type.Literal)), id: Type.Optional(Type.String()), scope: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("all")])), lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })), input: Type.Optional(Type.String()), end: Type.Optional(Type.Boolean()) }),
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted(); const session = ctx.sessionManager.getSessionId(); const all = args.scope === "all";
      if (args.action === "list") return result({ jobs: await jobs.list(session, all) });
      if (args.action === "clear") {
        const cleared = [];
        for (const job of await jobs.list(session, all)) if ((!args.id || job.id === args.id) && job.status !== "running") { await rm(jobs.dir(job.id), { recursive: true }); cleared.push(job.id); }
        return result({ cleared });
      }
      if (!args.id) throw new Error("id is required for this action");
      const job = await jobs.load(args.id, session, all);
      if (args.action === "write") await jobs.input(job, args.input ?? "", args.end ?? false);
      if (args.action === "kill") await jobs.kill(job);
      return result(await jobs.output(job, 1024 * 1024, args.lines ?? 100));
    } });
  pi.registerTool({ renderCall: renderSleepCall, renderResult: renderSleepResult, name: "sleep", label: "Wait", description: "Wait up to 120 seconds. Wake early for current-session job exit, swarm activity, or queued steering. Does not consume steering or kill jobs.",
    parameters: Type.Object({ seconds: Type.Number({ minimum: 0, maximum: 120 }) }),
    async execute(_id, { seconds }, signal, update, ctx) {
      const generation = activity;
      const running = (await jobs.list(ctx.sessionManager.getSessionId())).filter(job => job.status === "running");
      const until = Date.now() + seconds * 1000;
      let reason = "timeout";
      update?.(result({ remaining: seconds }));
      while (Date.now() < until) {
        signal?.throwIfAborted();
        if (activity !== generation || ctx.hasPendingMessages()) { reason = "activity"; break; }
        if ((await Promise.all(running.map(job => jobs.status(job)))).some(job => job.status !== "running")) { reason = "job_exit"; break; }
        update?.(result({ remaining: Math.max(0, (until - Date.now()) / 1000) }));
        await delay(Math.min(100, Math.max(1, until - Date.now())), undefined, { signal });
      }
      return result({ reason });
    } });
}
