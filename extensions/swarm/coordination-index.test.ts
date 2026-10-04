import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";
import { SwarmStore } from "./state.ts";
import { ReloadBarrier } from "./coordination.ts";
import type { Swarm } from "./controller.ts";
import { Workers } from "./worker.ts";
import { resumeDelays } from "./error-resume.ts";
import { health } from "./coordination.ts";

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

test("health warnings steer the direct parent's agent once per episode, not the user", () => fixture(async (h, store, root) => {
  const alive = Workers.prototype.alive, notices: string[] = [];
  let live = true;
  Workers.prototype.alive = async () => live;
  h.ctx.ui.notify = (text: string) => notices.push(text);
  try {
  h.ctx.cwd = root; await h.command("swarm:start", "Objective");
  const identity = h.entries.find(entry => entry.customType === "pi:swarm").data;
  const session = join(root, "worker.jsonl"); await writeFile(session, JSON.stringify({ type: "session", id: "worker-session" }));
  const quiet = await store.reserve(identity.run, identity.node, "Quiet", "Task");
  const old = new Date(Date.now() - 600_000).toISOString();
  await store.update(identity.run, state => { Object.assign(state.nodes[quiet.id], { status: "running", session, started: old }); });
  const alerts = () => h.sentMessages.filter(entry => entry.message.customType === "swarm-health-alert");
  const deadline = Date.now() + 3000;
  while (!alerts().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(alerts()).toHaveLength(1);
  expect(alerts()[0].message.content).toContain(`Quiet (${quiet.id}) is quiet-no-job`);
  expect(alerts()[0].message.content).toContain("owns no active jobs");
  expect(alerts()[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(alerts()).toHaveLength(1);
  const nested = await store.reserve(identity.run, identity.node, "Parent", "Task");
  await store.update(identity.run, state => { Object.assign(state.nodes[nested.id], { status: "running", session, started: new Date().toISOString() }); });
  const grandchild = await store.reserve(identity.run, nested.id, "Grandchild", "Task");
  await store.update(identity.run, state => { Object.assign(state.nodes[grandchild.id], { status: "running", session, started: old }); });
  live = false;
  const missing = Date.now() + 12_000;
  while (alerts().length < 3 && Date.now() < missing) await new Promise(resolve => setTimeout(resolve, 50));
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(alerts().map(entry => [entry.message.details.nodeId, entry.message.details.warning])).toEqual([
    [quiet.id, "quiet-no-job"], [quiet.id, "worker pane missing"], [nested.id, "worker pane missing"],
  ]);
  expect(notices.filter(text => text.includes("quiet") || text.includes("pane"))).toEqual([]);
  } finally { Workers.prototype.alive = alive; }
}), 20_000);

test("checkpoint tool ends the worker turn and gates jobs until an explicit barrier release", () => fixture(async (h, store, root) => {
  const run = await store.create("parent-session", root, "Objective"), worker = await store.reserve(run.id, run.root, "Worker", "Task");
  const session = join(root, "worker.jsonl"); await writeFile(session, JSON.stringify({ type: "session", id: "worker-session" }));
  await store.update(run.id, state => { Object.assign(state.nodes[worker.id], { status: "running", session }); });
  h.pi.appendEntry("pi:swarm", { run: run.id, node: worker.id }); await h.emit("session_start");
  const barrier = await new ReloadBarrier(store, {} as Swarm, async () => []).request(run.id, run.root);
  expect(await h.emit("tool_call", { toolName: "bash" })).toEqual([undefined]);
  const checkpoint = await h.call("swarm_reload", { action: "checkpoint", barrierId: barrier.id, checkpoint: "No jobs; pinned base and dirty files retained" });
  expect(checkpoint.terminate).toBe(true);
  for (const toolName of ["bash", "write", "edit", "swarm_spawn", "swarm_complete"]) expect((await h.emit("tool_call", { toolName }))[0]).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining("checkpoint hold") });
  expect((await h.emit("tool_call", { toolName: "bash", input: { command: "date" } }))).toEqual([undefined]);
  for (const toolName of ["codemode", "swarm_task", "read", "grep", "find", "ls", "compress", "search_context", "acp_status", "acp_cache", "decompress", "task_watch", "todo_write", "complain"]) {
    expect(await h.emit("tool_call", { toolName, input: {} })).toEqual([undefined]);
    expect((await store.read(run.id)).nodes[worker.id].permission?.status).toBe("checkpoint-hold");
  }
  expect((await h.emit("tool_call", { toolName: "decompress", input: { toFile: "checkpoint.md" } }))[0]).toMatchObject({ block: true, terminate: true });
  expect((await h.call("swarm_reload", { action: "status", barrierId: barrier.id })).details.members[0]).toMatchObject({ permission: { status: "checkpoint-hold" }, reload: { stage: "checkpointed" }, runtime: { revision: expect.any(String) } });
  await expect(h.call("swarm_reload", { action: "status", barrierId: barrier.id, thinking: "low" })).rejects.toThrow("apply only to action=restart");
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
    for (const toolName of ["codemode", "read", "grep", "find", "ls", "swarm_task", "swarm_send", "swarm_board", "swarm_complete", "swarm_observe", "task_query", "task_output", "task_stop", "task_watch", "todo_write", "complain", "compress", "search_context", "acp_status", "acp_cache", "decompress"]) {
      expect(await h.emit("tool_call", { toolName, input: {} })).toEqual([undefined]);
      expect((await store.read(run.id)).nodes[worker.id].permission).toEqual(before);
    }
    const status = { command: "git status --short", timeout: 120 };
    expect(await h.emit("tool_call", { toolName: "bash", input: status })).toEqual([undefined]);
    expect(status.timeout).toBe(15);
    for (const toolName of ["write", "edit", "bash", "swarm_spawn", "unknown_tool"]) {
      expect((await h.emit("tool_call", { toolName, input: {} }))[0]).toMatchObject({ block: true, terminate: true, reason: expect.stringContaining(permission) });
    }
    expect((await h.emit("tool_call", { toolName: "decompress", input: { toFile: "guidance.md" } }))[0]).toMatchObject({ block: true, terminate: true });
    const [prompt] = await h.emit("before_agent_start");
    expect(prompt.systemPromptOptions.promptGuidelines.join("\n")).toContain("These calls do not release the hold");
  }
  await store.send(run.id, run.root, worker.id, "instruction", "Bounded approved check", undefined, "released");
  expect(await h.emit("tool_call", { toolName: "bash" })).toEqual([undefined]);
  expect((await store.read(run.id)).nodes[worker.id].permission?.status).toBe("released");
  await h.call("swarm_send", { to: run.root, kind: "message", text: "Step done; what next?", activity: "waiting-instructions" });
  expect(await h.emit("tool_call", { toolName: "swarm_complete", input: { result: "Finished handoff" } })).toEqual([undefined]);
  expect((await h.call("swarm_complete", { result: "Finished handoff" })).details).toMatchObject({ status: "review", result: "Finished handoff" });
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

test("a worker resumes itself after a model error, then reports errored when resumes run out", () => fixture(async (h, store, root) => {
  const run = await store.create("parent-session", root, "Objective"), worker = await store.reserve(run.id, run.root, "Worker", "Task");
  await store.update(run.id, state => { state.nodes[worker.id].status = "running"; });
  h.pi.appendEntry("pi:swarm", { run: run.id, node: worker.id }); await h.emit("session_start");
  h.ctx.isIdle = () => true;
  const delays = resumeDelays.splice(0, resumeDelays.length, 20);
  try {
    const fail = async () => { await h.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "OpenAI Responses stream ended before a terminal response event" } }); await h.emit("agent_settled"); };
    await fail();
    const pending = (await store.read(run.id)).nodes[worker.id];
    expect(pending.activity?.status).toBe("errored");
    expect(typeof pending.activity?.resume).toBe("string");
    expect(health(pending, true, [], 300).state).not.toBe("errored");
    const resumes = () => h.sentMessages.filter(entry => entry.message.customType === "swarm-error-resume");
    const deadline = Date.now() + 2000;
    while (!resumes().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(resumes()).toHaveLength(1);
    expect(resumes()[0].message.content).toContain("automatic resume 1 of 1");
    expect(resumes()[0].options).toEqual({ triggerTurn: true });
    await fail();
    const exhausted = (await store.read(run.id)).nodes[worker.id];
    expect(exhausted.activity?.resume).toBeUndefined();
    expect(exhausted.activity?.detail).toContain("automatic resumes exhausted");
    expect(health(exhausted, true, [], 300).state).toBe("errored");
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(resumes()).toHaveLength(1);
    await h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }); await h.emit("agent_settled");
    expect((await store.read(run.id)).nodes[worker.id].activity?.status).toBe("working");
  } finally { resumeDelays.splice(0, resumeDelays.length, ...delays); }
}));

test("a worker can observe siblings read-only but cannot manage them", () => fixture(async (h, store, root) => {
  const run = await store.create("parent-session", root, "Objective");
  const reviewer = await store.reserve(run.id, run.root, "Reviewer", "Review siblings"), sibling = await store.reserve(run.id, run.root, "Sibling", "Build");
  const done = await store.reserve(run.id, run.root, "Done", "Finished step");
  await store.update(run.id, state => {
    for (const node of [reviewer, sibling]) state.nodes[node.id].status = "running";
    Object.assign(state.nodes[done.id], { status: "review", result: "Handoff text" });
  });
  const observe = Workers.prototype.observe, alive = Workers.prototype.alive;
  Workers.prototype.observe = async (id: string, lines: number) => `pane ${id} ${lines}`;
  Workers.prototype.alive = async () => true;
  try {
    h.pi.appendEntry("pi:swarm", { run: run.id, node: reviewer.id }); await h.emit("session_start");
    expect((await h.call("swarm_observe", { nodeId: sibling.id, lines: 5 })).content[0].text).toContain(`pane ${sibling.id} 5`);
    await expect(h.call("swarm_observe", { nodeId: run.root, lines: 5 })).rejects.toThrow("root session");
    await expect(h.call("swarm_observe", { nodeId: "missing", lines: 5 })).rejects.toThrow("Unknown node");
    expect((await h.call("swarm_health", {})).details).toEqual([]);
    expect((await h.call("swarm_health", { nodeId: run.root })).details.map((item: any) => item.nodeId).sort()).toEqual([reviewer.id, sibling.id, done.id].sort());
    expect((await h.call("swarm_health", { nodeId: sibling.id })).details).toMatchObject([{ nodeId: sibling.id, process: "present" }]);
    expect((await h.call("swarm_reviews", { owner: run.root })).details).toMatchObject([{ nodeId: done.id }]);
    expect((await h.call("swarm_reviews", { nodeId: done.id })).details).toMatchObject({ nodeId: done.id, result: "Handoff text" });
    await expect(h.call("swarm_stop", { nodeId: sibling.id })).rejects.toThrow("direct parent");
    await expect(h.call("swarm_review", { nodeId: done.id, decision: "accept", feedback: "ok" })).rejects.toThrow();
  } finally { Workers.prototype.observe = observe; Workers.prototype.alive = alive; }
}));
