import { renderResult, toolCall } from "../../lib/tool-preview.ts";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { result, restore } from "../../lib/common.ts";
import { Jobs } from "./jobs.ts";
import { SwarmStore, currentAssignment, descendants, terminal, type Run } from "./state.ts";
import { Swarm } from "./controller.ts";
import { Workers } from "./worker.ts";
import { preflightWorktree } from "./git.ts";
import { panel } from "./panel.ts";
import { packageRevision } from "./version.ts";
import { ownedJobs } from "./job-snapshot.ts";
import { ReloadBarrier, health, reviews, type Health } from "./coordination.ts";
import { coordinationGuidelines, treeSnapshot } from "./prompts.ts";
import { allowedDuringHold } from "./permissions.ts";
const key = "pi:swarm";
type Identity = { run: string; node: string };
// The status panel renders the latest snapshot synchronously; a timer refreshes it.
type View = { health?: Health[]; run?: Run; scope?: string; live: Set<string>; error?: string; tui?: { requestRender(): void }; timer?: ReturnType<typeof setInterval>; refreshing?: boolean };
export default function install(pi: ExtensionAPI) {
  const root = getAgentDir();
  const revision = packageRevision();
  let healthAt = 0;
  const healthAlerts = new Map<string, string>();
  const store = new SwarmStore(join(root, "swarm"));
  const workers = new Workers();
  let identity: Identity | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const alerted = new Set<string>();
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
  const reloads = async () => new ReloadBarrier(store, await controller(), node => ownedJobs(root, jobs, node));
  async function diagnostics(run: Run, scope: string, quietAfter: number) {
    return Promise.all(descendants(run, scope).filter(node => !terminal(node.status)).map(async node => {
      const live = await workers.alive(node.id);
      try { return health(node, live, await ownedJobs(root, jobs, node), quietAfter); }
      catch (error) { return health(node, live, [], quietAfter, Date.now(), String(error)); }
    }));
  }
  async function active(ctx: ExtensionContext) {
    if (!identity) throw new Error("Swarm is inactive. Only the user can activate /swarm:start <objective>");
    const run = await store.read(identity.run), node = run.nodes[identity.node];
    if (!node) throw new Error("Unknown swarm identity");
    if (node.parent && process.env.PI_SWARM_NODE === node.id && node.generation && process.env.PI_SWARM_GENERATION !== node.generation) throw new Error("Worker launch generation is stale");
    if (!node.parent && node.session !== ctx.sessionManager.getSessionId()) throw new Error("Swarm belongs to another root session");
    return { run, node };
  }
  async function poll(ctx: ExtensionContext) {
    if (!identity || polling) return;
    polling = true;
    try {
      const { run, node } = await active(ctx);
      if (Date.now() - healthAt >= 10_000) {
        healthAt = Date.now();
        const snapshots = await diagnostics(run, node.id, restore<number>(ctx, "pi:swarm-quiet") ?? 300);
        for (const snapshot of snapshots) {
          const worker = run.nodes[snapshot.nodeId];
          const expectedWait = worker.permission && worker.permission.status !== "released";
          const warning = snapshot.process === "missing" ? "worker pane missing" : snapshot.state.startsWith("quiet") && !expectedWait ? snapshot.state : undefined;
          if (!warning) { healthAlerts.delete(worker.id); continue; }
          const token = `${worker.generation ?? worker.started}:${warning}`;
          if (healthAlerts.get(worker.id) === token) continue;
          ctx.ui.notify(`Swarm ${worker.name}: ${warning}; last signal ${snapshot.quietSeconds ?? "unknown"} seconds ago. Inspect with swarm_health or swarm_observe; no automatic stop or restart.`, "warning");
          healthAlerts.set(worker.id, token);
        }
      }
      const awaiting = descendants(run, node.id).filter(child => child.status === "review");
      ctx.ui.setStatus("swarm-review", awaiting.length ? `swarm: ${awaiting.length} awaiting parent review` : undefined);
      for (const child of awaiting) {
        const alert = `${run.id}:${child.id}:${child.handoff?.revision ?? 1}`;
        if (alerted.has(alert)) continue;
        ctx.ui.notify(`Swarm ${child.name} awaits parent review (handoff revision ${child.handoff?.revision ?? 1}).`, "warning");
        alerted.add(alert);
      }
      if (node.parent && (node.status === "review" || terminal(node.status))) return;
      const messages = await store.inbox(run.id, node.id);
      for (const message of messages) {
        if (message.kind === "instruction" && !(await store.inbox(run.id, node.id)).some(entry => entry.id === message.id)) continue;
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
      const snapshots = await diagnostics(run, node.id, restore<number>(ctx, "pi:swarm-quiet") ?? 300);
      Object.assign(current, { health: snapshots, run, scope: node.id, live: new Set(nodes.filter((_, index) => alive[index]).map(entry => entry.id)), error: undefined });
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
        return current.run ? panel(current.run, current.scope!, current.live, width, (color, text) => theme.fg(color, text), Date.now(), current.health) : [];
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
    ctx.ui.setStatus("swarm-review", undefined);
    identity = process.env.PI_SWARM_NODE && process.env.PI_SWARM_RUN
      ? { run: process.env.PI_SWARM_RUN, node: process.env.PI_SWARM_NODE } : restore<Identity>(ctx, key);
    if (identity) {
      await store.recordRuntime(identity.run, identity.node, revision, process.env.PI_SWARM_GENERATION || undefined);
      await saveCurrent(ctx); timer = setInterval(() => void poll(ctx), 1000); timer.unref(); }
    if (view) { if (identity) await show(ctx); else hide(ctx); }
  };
  pi.on("session_start", load);
  pi.on("session_tree", load);
  pi.on("before_agent_start", async (event, ctx) => {
    if (!identity) return;
    await saveCurrent(ctx);
    const { run, node } = await active(ctx);
    return { systemPromptOptions: { ...event.systemPromptOptions,
      promptGuidelines: [...event.systemPromptOptions.promptGuidelines, ...coordinationGuidelines(node, run)],
    } };
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!identity) return;
    const { run, node } = await active(ctx);
    if (node.parent && (node.status === "review" || terminal(node.status))) {
      return { block: true, terminate: true, reason: `Swarm pause snapshot: worker was ${node.status} at this tool check (handoff revision ${node.handoff?.revision ?? 0}). A later parent resume can supersede this snapshot. Check swarm_tree for current state.` };
    }
    const holding = node.permission?.status === "checkpoint-hold" && node.reload?.stage !== "requested";
    const waiting = node.permission?.status === "waiting-approval" || node.permission?.status === "waiting-dependency";
    if (node.parent && (holding || waiting) && !allowedDuringHold(event.toolName, event.input)) return { block: true, terminate: true, reason: holding ? "Worker is on reload checkpoint hold. Read-only inspection and context housekeeping are allowed. Wait for the parent's explicit barrier release before editing or launching jobs." : `Worker permission is ${node.permission!.status}. Read-only inspection and context housekeeping are allowed. Coordinate with the parent and wait for explicit released permission before editing or launching jobs.` };
    if (node.parent && (node.resume?.status === "delivered" || !event.toolName.startsWith("swarm_"))) await store.observeTool(run.id, node.id, event.toolName);
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
  pi.registerCommand("swarm:quiet", { description: "Set the stale-activity warning threshold in seconds (default 300)", async handler(args, ctx) {
    await active(ctx);
    const seconds = Number(args);
    if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error("Quiet threshold must be a positive integer in seconds");
    pi.appendEntry("pi:swarm-quiet", seconds); healthAt = 0;
    ctx.ui.notify(`Swarm quiet threshold: ${seconds} seconds. Checks never stop or restart workers.`, "info");
  } });
  pi.registerCommand("swarm:reviews", { description: "Inspect the oldest pending direct-child handoffs and record a decision", async handler(_args, ctx) {
    const { run, node } = await active(ctx), queue = reviews(run, node.id);
    if (!queue.length) { ctx.ui.notify("No direct-child handoffs await review.", "info"); return; }
    const options = queue.map(item => `${item.name} | ${item.waitingSeconds ?? "unknown"}s | ${item.nodeId}`);
    const selection = await ctx.ui.select("Pending reviews, oldest first", options);
    if (selection === undefined) return;
    const item = queue[options.indexOf(selection)];
    if (!item) return;
    const action = await ctx.ui.select(`Review ${item.name}`, ["Inspect", "Accept", "Request changes", "Reject"]);
    if (action === "Inspect") {
      const fresh = (await store.read(run.id)).nodes[item.nodeId];
      pi.sendMessage({ customType: "swarm-handoff", content: `${fresh.name}, handoff revision ${fresh.handoff?.revision ?? 1}:\n${fresh.result}`, display: true }, { triggerTurn: false });
      return;
    }
    const decisions = { Accept: "accept", "Request changes": "request-changes", Reject: "reject" } as const;
    if (!action || !(action in decisions)) return;
    const feedback = await ctx.ui.input("Review feedback");
    if (feedback === undefined) return;
    await (await controller()).review(run.id, node.id, item.nodeId, decisions[action as keyof typeof decisions], feedback);
    await refresh(ctx);
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
        return completing || (name === "swarm_reload" && args.action === "checkpoint") ? { ...output, terminate: true } : output;
      } });
  }
  tool("swarm_task", "Read your durable assignment and root objective.", empty, async (_, ctx) => {
    const { run, node: loaded } = await active(ctx);
    const assignment = currentAssignment(loaded);
    const node = assignment ? await store.observeAssignment(run.id, loaded.id, assignment.generation, loaded.generation) : loaded;
    return { objective: run.objective, node, currentAssignment: assignment ?? null,
      historicalHandoff: node.result ? { result: node.result, handoff: node.handoff, feedback: node.feedback } : undefined,
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
  tool("swarm_reviews", "List your pending direct-child handoffs oldest first, with age and review owner. Set nodeId to inspect the full handoff. Decisions use swarm_review and do not imply code integration.", Type.Object({ nodeId: Type.Optional(Type.String()) }), async (args, ctx) => {
    const { run, node } = await active(ctx);
    if (!args.nodeId) return reviews(run, node.id);
    const worker = await (await controller()).owned(run.id, node.id, args.nodeId);
    if (worker.status !== "review") throw new Error("Worker has no result awaiting review");
    return { ...reviews(run, node.id).find(item => item.nodeId === worker.id), result: worker.result, delivery: worker.delivery };
  });
  tool("swarm_health", "Read-only worker process, job, and quiet-activity diagnostics. No automatic stop or restart. Known holds do not imply a stalled worker.", Type.Object({ quiet_seconds: Type.Optional(Type.Integer({ minimum: 1 })) }), async (args, ctx) => {
    const { run, node } = await active(ctx);
    return diagnostics(run, node.id, args.quiet_seconds ?? restore<number>(ctx, "pi:swarm-quiet") ?? 300);
  });
  tool("swarm_reload", "Durable direct-child reload barrier. Request checkpoints; workers checkpoint alone only after finishing or stopping owned jobs. Parent restarts after every checkpoint, waits for readiness and matching package revisions, then separately releases with one explicit bounded assignment per worker. Nested descendants must be terminal. Does not authorize work during restart.", Type.Object({ action: Type.Union(["request", "status", "checkpoint", "restart", "release"].map(value => Type.Literal(value))), barrierId: Type.Optional(Type.String()), nodeIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })), checkpoint: Type.Optional(Type.String({ minLength: 1 })), assignments: Type.Optional(Type.Array(Type.Object({ nodeId: Type.String(), task: Type.String({ minLength: 1 }) }))) }), async (args, ctx) => {
    const { run, node } = await active(ctx), manager = await reloads();
    if (args.action === "request") return manager.request(run.id, node.id, args.nodeIds);
    if (!args.barrierId) throw new Error("barrierId is required");
    const barrier = run.barriers?.[args.barrierId];
    if (!barrier || (barrier.owner !== node.id && !barrier.members.includes(node.id))) throw new Error("Reload barrier does not belong to this node");
    if (args.action === "status") return { ...barrier, members: barrier.members.map(id => ({ nodeId: id, reload: run.nodes[id].reload, runtime: run.nodes[id].runtime, generation: run.nodes[id].generation, permission: run.nodes[id].permission })) };
    if (args.action === "checkpoint") return manager.checkpoint(run.id, node.id, barrier.id, args.checkpoint ?? "");
    if (args.action === "restart") return manager.restart(run.id, node.id, barrier.id);
    if (args.action === "release") return manager.release(run.id, node.id, barrier.id, args.assignments ?? []);
    throw new Error("Invalid reload action");
  });
  tool("swarm_spawn", "Spawn one bounded step in an isolated worktree. Include scope, owned files, dependencies, checks, resource limits and commit permission. Workers do not inherit your conversation. Dirty trees require explicit dirtyMode. Maximum depth three.", Type.Object({ name: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }), dirtyMode: Type.Optional(Type.Union(["exclude", "commit-parent", "commit-child", "shared"].map(value => Type.Literal(value)))) }), async (args, ctx) => {
    const { run, node } = await active(ctx);
    return (await controller()).spawn(run.id, node.id, args.name, args.task, args.dirtyMode, { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: pi.getThinkingLevel(), fast: restore<boolean>(ctx, "pi:fast") ?? false });
  });
  tool("swarm_send", "Message your parent, direct child, or sibling by node ID. Only parents may send instructions; sibling messages are informational. Workers may report activity to their parent as working, waiting-instructions or waiting-dependency. Activity is a dated self-report, not proof of progress.", Type.Object({ to: Type.String(), kind: Type.Union([Type.Literal("message"), Type.Literal("instruction")]), text: Type.String({ minLength: 1 }), activity: Type.Optional(Type.Union(["working", "waiting-instructions", "waiting-dependency"].map(value => Type.Literal(value)))), permission: Type.Optional(Type.Union(["released", "waiting-approval", "waiting-dependency"].map(value => Type.Literal(value)))) }), async (args, ctx) => {
    const { run, node } = await active(ctx); return store.send(run.id, node.id, args.to, args.kind, args.text, args.activity, args.permission);
  });
  tool("swarm_broadcast", "Send one message or instruction to all nonterminal direct children in one atomic update. Workers awaiting review read it only if resumed. Does not stop running tools.", Type.Object({ kind: Type.Union([Type.Literal("message"), Type.Literal("instruction")]), text: Type.String({ minLength: 1 }), permission: Type.Optional(Type.Union(["released", "waiting-approval", "waiting-dependency"].map(value => Type.Literal(value)))) }), async (args, ctx) => {
    const { run, node } = await active(ctx);
    const messages = await store.broadcast(run.id, node.id, args.kind, args.text, args.permission);
    return { recipients: messages.map(message => message.to), count: messages.length };
  });
  tool("swarm_complete", "Submit a self-contained handoff: outcome, branch/tested base/commits, files, exact checks/results, evidence, limitations/blockers and next steps. All descendants must be terminal. Then wait; call alone, with no other tools in the batch.", Type.Object({ result: Type.String({ minLength: 1 }) }), async (args, ctx) => {
    const { run, node } = await active(ctx); const updated = await store.complete(run.id, node.id, args.result);
    return updated;
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
  tool("swarm_stop", "Stop an owned child. Retain worktree and session.", child, async (args, ctx) => {
    const { run, node } = await active(ctx); await (await controller()).stop(run.id, node.id, args.nodeId); return { nodeId: args.nodeId, action: "stop" };
  });
  tool("swarm_restart", "Restart an owned child. Retain worktree and session. Copy the parent's current model, thinking level and fast preference; supply thinking to override. Pass task for a new bounded assignment, saved before launch. Without current instructions after a completed handoff, the worker must ask the parent and wait. Does not change live workers.", Type.Object({ nodeId: Type.String(), task: Type.Optional(Type.String({ minLength: 1 })), thinking: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh"].map(level => Type.Literal(level)))) }), async (args, ctx) => {
    const { run, node } = await active(ctx);
    const thinking = args.thinking ?? pi.getThinkingLevel();
    await (await controller()).restart(run.id, node.id, args.nodeId, { task: args.task, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking, fast: restore<boolean>(ctx, "pi:fast") ?? false });
    return { nodeId: args.nodeId, action: "restart", thinking };
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
