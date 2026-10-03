import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";
import { SwarmStore } from "./state.ts";
import { ReloadBarrier } from "./coordination.ts";
import type { Swarm } from "./controller.ts";

async function fixture(check: (h: ReturnType<typeof harness>, store: SwarmStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-coordination-ui-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = harness(); h.ctx.isIdle = () => false;
  install(h.pi);
  try { await check(h, new SwarmStore(join(root, "swarm")), root); }
  finally {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("checkpoint tool ends the worker turn and gates jobs until an explicit barrier release", () => fixture(async (h, store, root) => {
  const run = await store.create("parent-session", root, "Objective"), worker = await store.reserve(run.id, run.root, "Worker", "Task");
  const session = join(root, "worker.jsonl"); await writeFile(session, JSON.stringify({ type: "session", id: "worker-session" }));
  await store.update(run.id, state => { Object.assign(state.nodes[worker.id], { status: "running", session }); });
  h.pi.appendEntry("pi:swarm", { run: run.id, node: worker.id }); await h.emit("session_start");
  const barrier = await new ReloadBarrier(store, {} as Swarm, async () => []).request(run.id, run.root);
  expect(await h.emit("tool_call", { toolName: "bash" })).toEqual([undefined]);
  const checkpoint = await h.call("swarm_reload", { action: "checkpoint", barrierId: barrier.id, checkpoint: "No jobs; pinned base and dirty files retained" });
  expect(checkpoint.terminate).toBe(true);
  for (const toolName of ["bash", "write", "edit", "swarm_spawn", "task_watch"]) expect((await h.emit("tool_call", { toolName }))[0]).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("checkpoint hold") });
  expect(await h.emit("tool_call", { toolName: "swarm_task" })).toEqual([undefined]);
  expect((await h.call("swarm_reload", { action: "status", barrierId: barrier.id })).details.members[0]).toMatchObject({ permission: { status: "checkpoint-hold" }, reload: { stage: "checkpointed" }, runtime: { revision: expect.any(String) } });
}));

test("permission waits block editing and jobs but permit parent coordination; tool activity does not release", () => fixture(async (h, store, root) => {
  const run = await store.create("parent-session", root, "Objective"), worker = await store.reserve(run.id, run.root, "Worker", "Task");
  await store.update(run.id, state => { state.nodes[worker.id].status = "running"; });
  h.pi.appendEntry("pi:swarm", { run: run.id, node: worker.id }); await h.emit("session_start");
  await h.call("swarm_send", { to: run.root, kind: "message", text: "Need approval", activity: "waiting-instructions" });
  expect((await h.emit("tool_call", { toolName: "write" }))[0]).toMatchObject({ block: true, reason: expect.stringContaining("waiting-approval") });
  expect(await h.emit("tool_call", { toolName: "swarm_send" })).toEqual([undefined]);
  await store.send(run.id, run.root, worker.id, "instruction", "Bounded approved check", undefined, "released");
  expect(await h.emit("tool_call", { toolName: "bash" })).toEqual([undefined]);
  expect((await store.read(run.id)).nodes[worker.id].permission?.status).toBe("released");
}));

test("review queue tool inspects only direct children and interactive command displays the handoff without deciding", () => fixture(async (h, store, root) => {
  h.ctx.cwd = root; await h.command("swarm:start", "Objective");
  const identity = h.entries.find(entry => entry.customType === "pi:swarm").data;
  const worker = await store.reserve(identity.run, identity.node, "Worker", "Task");
  await store.update(identity.run, state => { state.nodes[worker.id].status = "running"; });
  await store.complete(identity.run, worker.id, "Full verified handoff");
  const queue = (await h.call("swarm_reviews", {})).details;
  expect(queue).toHaveLength(1); expect(queue[0]).toMatchObject({ nodeId: worker.id, parent: identity.node, waitingSeconds: expect.any(Number) });
  expect((await h.call("swarm_reviews", { nodeId: worker.id })).details.result).toBe("Full verified handoff");
  let selected = 0; h.ctx.ui.select = async (_title: string, options: string[]) => ++selected === 1 ? options[0] : "Inspect";
  await h.command("swarm:reviews");
  expect(h.sentMessages.at(-1)?.message.content).toContain("Full verified handoff");
  expect(h.sentMessages.at(-1)?.options.triggerTurn).toBe(false);
  expect((await store.read(identity.run)).nodes[worker.id].status).toBe("review");
  await h.command("swarm:quiet", "120");
  expect(h.entries.at(-1).data).toBe(120);
  await expect(h.command("swarm:quiet", "0")).rejects.toThrow("positive integer");
}));
