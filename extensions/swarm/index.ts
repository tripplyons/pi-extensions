import { renderResult } from "../../lib/tool-preview.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { result, restore, stateRoot } from "../../lib/common.ts";
import { Jobs } from "../shell/jobs.ts";
import { SwarmStore, descendants } from "./state.ts";
import { Swarm } from "./controller.ts";
import { Workers } from "./worker.ts";
import { preflightWorktree } from "./git.ts";
const key = "rework:swarm";
type Identity = { run: string; node: string };
export default function install(pi: ExtensionAPI) {
  const root = stateRoot();
  const store = new SwarmStore(join(root, "swarm"));
  const workers = new Workers();
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  let identity: Identity | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const jobs = new Jobs(join(root, "jobs"));
  const controller = async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    return new Swarm(store, workers, manifest.pi.extensions.map((path: string) => join(packageRoot, path)), async node => {
      if (!node.session) return;
      let header;
      try { header = JSON.parse((await readFile(node.session, "utf8")).split("\n")[0]); }
      catch (error: any) { if (error.code === "ENOENT") return; throw error; }
      if (header.type !== "session" || typeof header.id !== "string") throw new Error("Invalid worker session header");
      for (const job of await jobs.list(header.id)) await jobs.kill(job);
    });
  };
  async function active(ctx: ExtensionContext) {
    if (!identity) throw new Error("Swarm is inactive. Only the user can activate /swarm:start <objective>");
    const run = await store.read(identity.run), node = run.nodes[identity.node];
    if (!node) throw new Error("Unknown swarm identity");
    if (!node.parent && node.session !== ctx.sessionManager.getSessionId()) throw new Error("Swarm belongs to another root session");
    return { run, node };
  }
  async function poll(ctx: ExtensionContext) {
    if (!identity || polling) return;
    polling = true;
    try {
      const { run, node } = await active(ctx);
      const messages = await store.inbox(run.id, node.id);
      for (const message of messages) {
        pi.sendMessage({ customType: "swarm-message", content: JSON.stringify(message), display: true }, { triggerTurn: true, deliverAs: "followUp" });
        await store.acknowledge(run.id, node.id, message.id);
        pi.events.emit("rework:swarm-activity", message);
      }
    } catch (error) { ctx.ui.setStatus("swarm-error", String(error)); }
    finally { polling = false; }
  }
  const load = async (_event: unknown, ctx: ExtensionContext) => {
    if (timer) clearInterval(timer);
    identity = process.env.PI_SWARM_NODE && process.env.PI_SWARM_RUN
      ? { run: process.env.PI_SWARM_RUN, node: process.env.PI_SWARM_NODE } : restore<Identity>(ctx, key);
    if (identity) { timer = setInterval(() => void poll(ctx), 1000); timer.unref(); }
  };
  for (const event of ["session_start", "session_switch", "session_fork", "session_tree"] as const) pi.on(event, load);
  pi.on("session_shutdown", async () => { if (timer) clearInterval(timer); });
  pi.registerCommand("swarm:start", { description: "Activate a swarm for this session: <objective>", async handler(objective, ctx) {
    if (process.env.PI_SWARM_NODE) throw new Error("Workers cannot activate swarms");
    if (identity) throw new Error("A swarm is already associated with this session");
    const run = await store.create(ctx.sessionManager.getSessionId(), ctx.cwd, objective);
    identity = { run: run.id, node: run.root }; pi.appendEntry(key, identity);
    pi.events.emit("rework:swarm-attached", ctx);
    await load({}, ctx); ctx.ui.notify("Swarm activated. Workers start only when spawned.", "info");
  } });
  const empty = Type.Object({});
  const child = Type.Object({ nodeId: Type.String() });
  function tool(name: string, description: string, parameters: any, execute: (args: any, ctx: ExtensionContext) => Promise<unknown>) {
    pi.registerTool({ renderResult, name, label: name, description: `${description} Requires user activation through /swarm:start.`, parameters,
      async execute(_id, args, signal, _update, ctx) { signal?.throwIfAborted(); return result(await execute(args, ctx)); } });
  }
  tool("swarm_task", "Read your durable assignment and root objective.", empty, async (_, ctx) => {
    const { run, node } = await active(ctx); return { objective: run.objective, node };
  });
  tool("swarm_tree", "Inspect the swarm tree and retained branches.", empty, async (_, ctx) => {
    const { run } = await active(ctx); return Object.values(run.nodes);
  });
  tool("swarm_spawn", "Spawn a child in an isolated worktree. Dirty trees require explicit dirtyMode. Maximum depth three.", Type.Object({ name: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }), dirtyMode: Type.Optional(Type.Union(["exclude", "commit-parent", "commit-child", "shared"].map(Type.Literal))) }), async (args, ctx) => {
    const { run, node } = await active(ctx);
    return (await controller()).spawn(run.id, node.id, args.name, args.task, args.dirtyMode, { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: pi.getThinkingLevel() });
  });
  tool("swarm_send", "Message a direct relative. Only parents may send instructions.", Type.Object({ to: Type.String(), kind: Type.Union([Type.Literal("message"), Type.Literal("instruction")]), text: Type.String({ minLength: 1 }) }), async (args, ctx) => {
    const { run, node } = await active(ctx); return store.send(run.id, node.id, args.to, args.kind, args.text);
  });
  tool("swarm_complete", "Submit results for parent review after all descendants are terminal.", Type.Object({ result: Type.String({ minLength: 1 }) }), async (args, ctx) => {
    const { run, node } = await active(ctx); const updated = await store.complete(run.id, node.id, args.result);
    await store.send(run.id, node.id, node.parent!, "message", `Result ready for review: ${args.result}`); return updated;
  });
  tool("swarm_review", "Review a direct child's result; accept/reject stops it without merging.", Type.Object({ nodeId: Type.String(), decision: Type.Union(["accept", "reject", "request-changes"].map(Type.Literal)), feedback: Type.String() }), async (args, ctx) => {
    const { run, node } = await active(ctx); return (await controller()).review(run.id, node.id, args.nodeId, args.decision, args.feedback);
  });
  tool("swarm_observe", "Capture bounded terminal output from a direct child.", Type.Object({ nodeId: Type.String(), lines: Type.Integer({ minimum: 1, maximum: 2000 }) }), async (args, ctx) => {
    const { run, node } = await active(ctx); await (await controller()).owned(run.id, node.id, args.nodeId); return workers.observe(args.nodeId, args.lines);
  });
  for (const action of ["stop", "restart"] as const) tool(`swarm_${action}`, `${action} an owned child. Retain worktree and session.`, child, async (args, ctx) => {
    const { run, node } = await active(ctx); await (await controller())[action](run.id, node.id, args.nodeId); return { nodeId: args.nodeId, action };
  });
  for (const action of ["kill", "cleanup"] as const) tool(`swarm_${action}`, `Root only: ${action === "kill" ? "stop all workers and their jobs" : "remove clean terminal worktrees"}. Preserve branches.`, empty, async (_, ctx) => {
    const { run, node } = await active(ctx); return { action, removed: await (await controller())[action](run.id, node.id) };
  });
  tool("swarm_clear", "Root only: preflight worktrees, stop all workers, remove worktrees and run state. Preserve branches.", empty, async (_, ctx) => {
    const { run, node } = await active(ctx);
    if (node.id !== run.root) throw new Error("Only root can clear a swarm");
    for (const descendant of descendants(run, run.root)) if (descendant.worktree) await preflightWorktree(descendant.worktree);
    const swarm = await controller(); await swarm.kill(run.id, node.id); await swarm.cleanup(run.id, node.id);
    await rm(store.path(run.id), { recursive: true }); identity = undefined; pi.appendEntry(key, null);
    if (timer) clearInterval(timer); return { cleared: run.id };
  });
}
