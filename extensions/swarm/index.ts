import { renderResult, toolCall } from "../../lib/tool-preview.ts";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { result, restore } from "../../lib/common.ts";
import { Jobs } from "./jobs.ts";
import { SwarmStore, descendants, terminal, type Run } from "./state.ts";
import { Swarm } from "./controller.ts";
import { Workers } from "./worker.ts";
import { preflightWorktree } from "./git.ts";
import { panel } from "./panel.ts";
import { coordinationGuidelines, treeSnapshot } from "./prompts.ts";
const key = "pi:swarm";
type Identity = { run: string; node: string };
// The status panel renders the latest snapshot synchronously; a timer refreshes it.
type View = { run?: Run; scope?: string; live: Set<string>; error?: string; tui?: { requestRender(): void }; timer?: ReturnType<typeof setInterval>; refreshing?: boolean };
export default function install(pi: ExtensionAPI) {
  const root = getAgentDir();
  const store = new SwarmStore(join(root, "swarm"));
  const workers = new Workers();
  let identity: Identity | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let view: View | undefined;
  const jobs = new Jobs(join(root, "jobs"));
  const controller = async () => {
    return new Swarm(store, workers, async node => {
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
      if (node.parent && (node.status === "review" || terminal(node.status))) return;
      const messages = await store.inbox(run.id, node.id);
      for (const message of messages) {
        const sender = run.nodes[message.from];
        const senderName = sender?.name ?? "unknown worker";
        pi.sendMessage({
          customType: "swarm-message",
          content: `Swarm ${message.kind} from ${senderName} (${message.from}):\n${message.text}`,
          display: true,
          details: { runId: run.id, messageId: message.id, from: message.from, kind: message.kind },
        }, { triggerTurn: true, deliverAs: "steer" });
        await store.acknowledge(run.id, node.id, message.id);
        pi.events.emit("pi:swarm-activity", message);
      }
    } catch (error) { ctx.ui.setStatus("swarm-error", String(error)); }
    finally { polling = false; }
  }
  async function refresh(ctx: ExtensionContext) {
    const current = view;
    if (!current || current.refreshing) return;
    current.refreshing = true;
    try {
      const { run, node } = await active(ctx);
      const nodes = descendants(run, node.id).filter(entry => !terminal(entry.status));
      const alive = await Promise.all(nodes.map(entry => workers.alive(entry.id)));
      Object.assign(current, { run, scope: node.id, live: new Set(nodes.filter((_, index) => alive[index]).map(entry => entry.id)), error: undefined });
    } catch (error) { current.error = String(error); }
    finally { current.refreshing = false; }
    current.tui?.requestRender();
  }
  function hide(ctx: ExtensionContext) {
    if (view?.timer) clearInterval(view.timer);
    view = undefined; ctx.ui.setWidget("swarm", undefined);
  }
  async function show(ctx: ExtensionContext) {
    if (view?.timer) clearInterval(view.timer);
    const current = view ??= { live: new Set() };
    ctx.ui.setWidget("swarm", (tui, theme) => {
      current.tui = tui;
      return { invalidate() {}, render(width: number) {
        if (current.error) return [truncateToWidth(theme.fg("error", `swarm: ${current.error}`), width)];
        return current.run ? panel(current.run, current.scope!, current.live, width, (color, text) => theme.fg(color, text)) : [];
      } };
    }, { placement: "belowEditor" });
    current.timer = setInterval(() => void refresh(ctx), 2000); current.timer.unref();
    await refresh(ctx);
  }
  async function saveCurrent(ctx: ExtensionContext, model = ctx.model, thinking = pi.getThinkingLevel()) {
    if (!identity || !model) return;
    const current = { model: `${model.provider}/${model.id}`, thinking };
    const { run, node } = await active(ctx);
    if (node.current?.model === current.model && node.current.thinking === current.thinking) return;
    await store.update(run.id, state => { state.nodes[node.id].current = current; });
  }
  pi.on("model_select", (event, ctx) => saveCurrent(ctx, event.model));
  pi.on("thinking_level_select", (event, ctx) => saveCurrent(ctx, ctx.model, event.level));
  const load = async (_event: unknown, ctx: ExtensionContext) => {
    if (timer) clearInterval(timer);
    identity = process.env.PI_SWARM_NODE && process.env.PI_SWARM_RUN
      ? { run: process.env.PI_SWARM_RUN, node: process.env.PI_SWARM_NODE } : restore<Identity>(ctx, key);
    if (identity) { await saveCurrent(ctx); timer = setInterval(() => void poll(ctx), 1000); timer.unref(); }
    if (view) { if (identity) await show(ctx); else hide(ctx); }
  };
  pi.on("session_start", load);
  pi.on("session_tree", load);
  pi.on("before_agent_start", async (event, ctx) => {
    if (!identity) return;
    await saveCurrent(ctx);
    const { node } = await active(ctx);
    return { systemPromptOptions: { ...event.systemPromptOptions,
      promptGuidelines: [...event.systemPromptOptions.promptGuidelines, ...coordinationGuidelines(node)],
    } };
  });
  pi.on("tool_call", async (_event, ctx) => {
    if (!identity) return;
    const { node } = await active(ctx);
    if (node.parent && (node.status === "review" || terminal(node.status))) {
      return { block: true, terminate: true, reason: `Swarm worker is ${node.status}; tools are paused until the parent resumes it.` };
    }
  });
  pi.on("session_shutdown", async () => { if (timer) clearInterval(timer); if (view?.timer) clearInterval(view.timer); });
  pi.registerCommand("swarm:start", { description: "Activate a swarm for this session: <objective>", async handler(objective, ctx) {
    if (process.env.PI_SWARM_NODE) throw new Error("Workers cannot activate swarms");
    if (identity) throw new Error("A swarm is already associated with this session");
    const run = await store.create(ctx.sessionManager.getSessionId(), ctx.cwd, objective);
    identity = { run: run.id, node: run.root }; pi.appendEntry(key, identity);
    pi.events.emit("pi:swarm-attached", ctx);
    await load({}, ctx); ctx.ui.notify("Swarm activated. Workers start only when spawned.", "info");
  } });
  pi.registerCommand("swarm:kill", { description: "Stop all swarm workers and their jobs. Keep worktrees, sessions and branches.", async handler(_args, ctx) {
    if (process.env.PI_SWARM_NODE) throw new Error("Workers cannot kill the swarm");
    const { run, node } = await active(ctx);
    const stopped = await (await controller()).kill(run.id, node.id);
    await refresh(ctx);
    ctx.ui.notify(stopped.length ? `Stopped ${stopped.length} swarm worker${stopped.length === 1 ? "" : "s"}. Worktrees, sessions and branches are kept.` : "No swarm workers are active.", "info");
  } });
  pi.registerCommand("swarm:status", { description: "Toggle the swarm status panel below the editor", async handler(_args, ctx) {
    if (view) return hide(ctx);
    await active(ctx); await show(ctx);
  } });
  const empty = Type.Object({});
  const child = Type.Object({ nodeId: Type.String() });
  function tool(name: string, description: string, parameters: any, execute: (args: any, ctx: ExtensionContext) => Promise<unknown>) {
    const completing = name === "swarm_complete";
    pi.registerTool({ renderCall: toolCall(name), renderResult, name, label: name, description: `${description} Requires user activation through /swarm:start.`, parameters,
      exposure: completing ? "model-only" : undefined,
      async execute(_id, args, signal, _update, ctx) {
        signal?.throwIfAborted();
        const output = result(await execute(args, ctx));
        return completing ? { ...output, terminate: true } : output;
      } });
  }
  tool("swarm_task", "Read your durable assignment and root objective.", empty, async (_, ctx) => {
    const { run, node } = await active(ctx);
    return { objective: run.objective, node,
      parent: node.parent ? { id: node.parent, name: run.nodes[node.parent].name, branch: run.nodes[node.parent].branch, cwd: run.nodes[node.parent].worktree?.cwd } : undefined,
      siblings: Object.values(run.nodes).filter(entry => node.parent && entry.parent === node.parent && entry.id !== node.id && !terminal(entry.status)).map(entry => ({ id: entry.id, name: entry.name, status: entry.status })),
    };
  });
  tool("swarm_tree", "List compact worker summaries with launch/current models, handoff state and per-revision code evidence. Set nodeId for a full record, includeTerminal for retained workers, or model for an exact effective provider/model filter. Counts remain run-wide.", Type.Object({ nodeId: Type.Optional(Type.String()), includeTerminal: Type.Optional(Type.Boolean()), model: Type.Optional(Type.String({ minLength: 1 })) }), async (args, ctx) => {
    const { run } = await active(ctx);
    if (args.nodeId && args.model) throw new Error("model filters compact summaries; omit nodeId");
    if (!args.nodeId) return treeSnapshot(run, args.includeTerminal, args.model);
    const node = run.nodes[args.nodeId];
    if (!node) throw new Error("Unknown swarm node");
    return node;
  });
  tool("swarm_spawn", "Spawn one bounded step in an isolated worktree. Include scope, owned files, dependencies, checks, resource limits and commit permission. Workers do not inherit your conversation. Dirty trees require explicit dirtyMode. Maximum depth three.", Type.Object({ name: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }), dirtyMode: Type.Optional(Type.Union(["exclude", "commit-parent", "commit-child", "shared"].map(value => Type.Literal(value)))) }), async (args, ctx) => {
    const { run, node } = await active(ctx);
    return (await controller()).spawn(run.id, node.id, args.name, args.task, args.dirtyMode, { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: pi.getThinkingLevel(), fast: restore<boolean>(ctx, "pi:fast") ?? false });
  });
  tool("swarm_send", "Message your parent, direct child, or sibling by node ID. Only parents may send instructions; sibling messages are informational.", Type.Object({ to: Type.String(), kind: Type.Union([Type.Literal("message"), Type.Literal("instruction")]), text: Type.String({ minLength: 1 }) }), async (args, ctx) => {
    const { run, node } = await active(ctx); return store.send(run.id, node.id, args.to, args.kind, args.text);
  });
  tool("swarm_broadcast", "Send one message or instruction to all nonterminal direct children in one atomic update. Workers awaiting review read it only if resumed. Does not stop running tools.", Type.Object({ kind: Type.Union([Type.Literal("message"), Type.Literal("instruction")]), text: Type.String({ minLength: 1 }) }), async (args, ctx) => {
    const { run, node } = await active(ctx);
    const messages = await store.broadcast(run.id, node.id, args.kind, args.text);
    return { recipients: messages.map(message => message.to), count: messages.length };
  });
  tool("swarm_complete", "Submit a self-contained handoff: outcome, branch/tested base/commits, files, exact checks/results, evidence, limitations/blockers and next steps. All descendants must be terminal. Then wait; call alone, with no other tools in the batch.", Type.Object({ result: Type.String({ minLength: 1 }) }), async (args, ctx) => {
    const { run, node } = await active(ctx); const updated = await store.complete(run.id, node.id, args.result);
    await store.send(run.id, node.id, node.parent!, "message", `Submitted a result for review. Read the handoff with swarm_tree nodeId=${node.id}.`); return updated;
  });
  tool("swarm_review", "Accept/reject a direct child's handoff and stop it without merging. This does not mark code reviewed, tested or integrated; use swarm_record for per-revision evidence.", Type.Object({ nodeId: Type.String(), decision: Type.Union(["accept", "reject", "request-changes"].map(value => Type.Literal(value))), feedback: Type.String() }), async (args, ctx) => {
    const { run, node } = await active(ctx); return (await controller()).review(run.id, node.id, args.nodeId, args.decision, args.feedback);
  });
  tool("swarm_record", "Record parent-reported evidence for a direct child's revision: reviewed, tested or integrated. These are independent states, never inferred from handoff acceptance. Use a full commit hash, or result for a no-commit handoff. Include exact checks or integration commit in evidence.", Type.Object({ nodeId: Type.String(), revision: Type.String(), stage: Type.Union(["reviewed", "tested", "integrated"].map(value => Type.Literal(value))), evidence: Type.String({ minLength: 1 }) }), async (args, ctx) => {
    const { run, node } = await active(ctx);
    return store.recordDelivery(run.id, node.id, args.nodeId, args.revision, args.stage, args.evidence);
  });
  tool("swarm_replace", "Graceful direct-child replacement. action=request sends one wrap-up instruction without stopping tools. After swarm_complete and parent acceptance, action=start requires name, task, explicit model and testedBase. Copies predecessor commits and dirty WIP to an isolated successor without committing, merging or deleting the predecessor. Failed successors require inspection, not another start.", Type.Object({ nodeId: Type.String(), action: Type.Union([Type.Literal("request"), Type.Literal("start")]), name: Type.Optional(Type.String({ minLength: 1 })), task: Type.Optional(Type.String({ minLength: 1 })), model: Type.Optional(Type.String({ minLength: 1 })), thinking: Type.Optional(Type.String()), testedBase: Type.Optional(Type.String({ minLength: 1 })) }), async (args, ctx) => {
    const { run, node } = await active(ctx);
    if (args.action === "request") return store.requestReplacement(run.id, node.id, args.nodeId);
    if (args.action !== "start") throw new Error("Invalid replacement action");
    for (const field of ["name", "task", "model", "testedBase"] as const) if (!args[field]?.trim()) throw new Error(`Replacement start requires ${field}`);
    return (await controller()).replace(run.id, node.id, args.nodeId, args.name, args.task, args.testedBase, { model: args.model, thinking: args.thinking ?? pi.getThinkingLevel(), fast: restore<boolean>(ctx, "pi:fast") ?? false });
  });
  tool("swarm_observe", "Capture bounded terminal output from a direct child.", Type.Object({ nodeId: Type.String(), lines: Type.Integer({ minimum: 1, maximum: 2000 }) }), async (args, ctx) => {
    const { run, node } = await active(ctx); await (await controller()).owned(run.id, node.id, args.nodeId); return workers.observe(args.nodeId, args.lines);
  });
  for (const action of ["stop", "restart"] as const) tool(`swarm_${action}`, `${action} an owned child. Retain worktree and session.`, child, async (args, ctx) => {
    const { run, node } = await active(ctx); await (await controller())[action](run.id, node.id, args.nodeId); return { nodeId: args.nodeId, action };
  });
  for (const action of ["kill", "cleanup"] as const) tool(`swarm_${action}`, `Root only: ${action === "kill" ? "stop all workers and their jobs" : "remove clean terminal worktrees"}. Preserve branches.`, empty, async (_, ctx) => {
    const { run, node } = await active(ctx); const ids = await (await controller())[action](run.id, node.id);
    return action === "kill" ? { action, stopped: ids } : { action, removed: ids };
  });
  tool("swarm_clear", "Root only: preflight worktrees, stop all workers, remove worktrees and run state. Preserve branches.", empty, async (_, ctx) => {
    const { run, node } = await active(ctx);
    if (node.id !== run.root) throw new Error("Only root can clear a swarm");
    for (const descendant of descendants(run, run.root)) if (descendant.worktree) await preflightWorktree(descendant.worktree);
    const swarm = await controller(); await swarm.kill(run.id, node.id); await swarm.cleanup(run.id, node.id);
    await rm(store.path(run.id), { recursive: true }); identity = undefined; pi.appendEntry(key, null);
    if (timer) clearInterval(timer); if (view) hide(ctx); return { cleared: run.id };
  });
}
