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

test("overdue direct-child backlog steers the parent once and preserves independent integration evidence", () => fixture(async (h, store, root) => {
  h.ctx.cwd = root; h.ctx.hasPendingMessages = () => true;
  await h.command("swarm:start", "Objective");
  const identity = h.entries.find(entry => entry.customType === "pi:swarm").data;
  const workers = [];
  for (let i = 0; i < 4; i++) {
    const worker = await store.reserve(identity.run, identity.node, `Worker ${i}`, "Task");
    await store.update(identity.run, state => { state.nodes[worker.id].status = "running"; });
    await store.complete(identity.run, worker.id, "Verified handoff");
    workers.push(worker);
  }
  await store.recordDelivery(identity.run, identity.node, workers[0].id, "a".repeat(40), "integrated", "Cherry-picked exact revision");
  await store.update(identity.run, state => {
    for (let i = 0; i < workers.length; i++) state.nodes[workers[i].id].handoff!.submitted = new Date(Date.now() - (900 - i) * 1000).toISOString();
  });
  const statuses: string[] = [];
  const reminderStatuses: string[] = [];
  h.ctx.ui.setStatus = (key: string, text: string) => {
    if (key === "swarm-review") statuses.push(text);
    if (key === "swarm-review-reminder") reminderStatuses.push(text);
  };
  const reminders = () => h.sentMessages.filter(entry => entry.message.customType === "swarm-review-reminder");
  const deadline = Date.now() + 4000;
  while (!reminders().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(reminders()).toHaveLength(1);
  expect(reminders()[0]).toMatchObject({ options: { triggerTurn: true, deliverAs: "steer" }, message: { details: { owner: identity.node, pending: 4, overdue: 4, integrated: 1 } } });
  expect(reminders()[0].message.content).toContain("1 more");
  expect(reminders()[0].message.content).toContain("code integration recorded, handoff undecided");
  expect(statuses).toContain("swarm: 4 awaiting parent review (4 overdue; 1 with recorded integration, undecided)");
  expect(reminderStatuses.at(-1)).toContain("queued");
  const queue = (await h.call("swarm_reviews", {})).details;
  expect(queue[0].reminder).toMatchObject({ state: "queued", queuedAt: expect.any(String) });
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(reminders()).toHaveLength(1);
  await h.emit("message_end", { message: { ...reminders()[0].message, role: "custom" } });
  const inspected = (await h.call("swarm_reviews", { nodeId: workers[0].id })).details;
  expect(inspected.reminder).toMatchObject({ state: "delivered", deliveredAt: expect.any(String), scheduledAt: expect.any(String) });
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(reminders()).toHaveLength(1);
  expect(reminderStatuses.at(-1)).toContain("delivered");
  const node = (await store.read(identity.run)).nodes[workers[0].id];
  expect(node.handoff?.status).toBe("awaiting-parent"); expect(node.status).toBe("review");
  expect(node.delivery?.[0].reviewed).toBeUndefined(); expect(node.delivery?.[0].tested).toBeUndefined();
  for (const worker of workers) await store.review(identity.run, identity.node, worker.id, "accept", "Explicit decision");
  const clearDeadline = Date.now() + 3000;
  while (statuses.at(-1) !== undefined && Date.now() < clearDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(statuses.at(-1)).toBeUndefined(); expect(reminders()).toHaveLength(1);
}));

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
  for (const toolName of ["codemode", "swarm_task", "read", "grep", "find", "ls", "compress", "search_context", "acp_status", "acp_cache", "decompress"]) {
    expect(await h.emit("tool_call", { toolName, input: {} })).toEqual([undefined]);
    expect((await store.read(run.id)).nodes[worker.id].permission?.status).toBe("checkpoint-hold");
  }
  expect((await h.emit("tool_call", { toolName: "decompress", input: { toFile: "checkpoint.md" } }))[0]).toMatchObject({ block: true, terminate: true });
  expect((await h.call("swarm_reload", { action: "status", barrierId: barrier.id })).details.members[0]).toMatchObject({ permission: { status: "checkpoint-hold" }, reload: { stage: "checkpointed" }, runtime: { revision: expect.any(String) } });
}));

test("permission waits permit read-only inspection and housekeeping without releasing edits or jobs", () => fixture(async (h, store, root) => {
  const run = await store.create("parent-session", root, "Objective"), worker = await store.reserve(run.id, run.root, "Worker", "Task");
  await store.update(run.id, state => { state.nodes[worker.id].status = "running"; });
  h.pi.appendEntry("pi:swarm", { run: run.id, node: worker.id }); await h.emit("session_start");
  await h.call("swarm_send", { to: run.root, kind: "message", text: "Need approval", activity: "waiting-instructions" });
  for (const permission of ["waiting-approval", "waiting-dependency"] as const) {
    await store.send(run.id, run.root, worker.id, "instruction", "Read revised guidance; keep implementation held", undefined, permission);
    const before = (await store.read(run.id)).nodes[worker.id].permission;
    const task = (await h.call("swarm_task", {})).details;
    expect(task.currentAssignment.text).toContain("Task");
    expect(task.currentAssignment.text).toContain("Read revised guidance; keep implementation held");
    expect(typeof task.currentAssignment.generation).toBe("number");
    expect(task.node.observedAssignment.generation).toBe(task.currentAssignment.generation);
    expect((await store.read(run.id)).nodes[worker.id].observedAssignment?.generation).toBe(task.currentAssignment.generation);
    for (const toolName of ["codemode", "read", "grep", "find", "ls", "swarm_task", "swarm_send", "swarm_observe", "task_query", "task_output", "task_stop", "compress", "search_context", "acp_status", "acp_cache", "decompress"]) {
      expect(await h.emit("tool_call", { toolName, input: {} })).toEqual([undefined]);
      expect((await store.read(run.id)).nodes[worker.id].permission).toEqual(before);
    }
    for (const toolName of ["write", "edit", "bash", "swarm_spawn", "task_watch", "unknown_tool"]) {
      expect((await h.emit("tool_call", { toolName, input: {} }))[0]).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining(permission) });
    }
    expect((await h.emit("tool_call", { toolName: "decompress", input: { toFile: "guidance.md" } }))[0]).toMatchObject({ block: true, terminate: true });
    const [prompt] = await h.emit("before_agent_start");
    expect(prompt.systemPromptOptions.promptGuidelines.join("\n")).toContain("These calls do not release the hold");
  }
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
