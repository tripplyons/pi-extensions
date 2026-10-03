import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SwarmStore, currentAssignment } from "./state.ts";
import { coordinationGuidelines } from "./prompts.ts";
import install from "./index.ts";
import { harness } from "../../lib/harness.ts";

async function fixture(check: (store: SwarmStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-instructions-"));
  try { await check(new SwarmStore(root), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("repeated base updates preserve each worker's task list through delivery and recovery", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Build feature");
  const tasks = ["1. Implement normals\n2. Test normals\nOwn normals.ts; commit allowed", "1. Implement passive\n2. Test passive\nOwn passive.ts; no commits"];
  const workers = await Promise.all(tasks.map((task, i) => store.reserve(run.id, run.root, `Worker ${i}`, task)));
  const permissions = workers.map(worker => worker.permission);
  await store.update(run.id, state => { for (const worker of workers) state.nodes[worker.id].status = "running"; });
  for (let i = 0; i < 15; i++) {
    await store.broadcast(run.id, run.root, "instruction", `New main base-${i}. Rebase before your next code commit.`);
    if (i === 7) for (const worker of workers) {
      const [message] = await store.inbox(run.id, worker.id);
      await store.acknowledge(run.id, worker.id, message.id);
    }
  }
  const recovered = new SwarmStore(root), state = await recovered.read(run.id);
  for (const [i, worker] of workers.entries()) {
    const node = state.nodes[worker.id], assignment = currentAssignment(node)!;
    expect(assignment.text.startsWith(tasks[i])).toBe(true);
    for (let base = 0; base < 15; base++) expect(assignment.text).toContain(`New main base-${base}.`);
    expect(assignment.generation).toBe(16);
    expect(node.permission).toEqual(permissions[i]);
    expect(node.task).toBe(tasks[i]);
    const [message] = await recovered.inbox(run.id, worker.id);
    expect(message).toMatchObject({ assignmentMode: "append", text: assignment.text });
    expect(await recovered.inbox(run.id, worker.id)).toHaveLength(1);
    await recovered.acknowledge(run.id, worker.id, message.id);
    expect(currentAssignment((await recovered.read(run.id)).nodes[worker.id])).toEqual(assignment);
  }
}));

test("informational notices preserve assignments; explicit replacement discards only the active scope", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective"), worker = await store.reserve(run.id, run.root, "Worker", "Original task; own source.ts; run tests");
  const before = currentAssignment(worker);
  await store.send(run.id, run.root, worker.id, "message", "Main advanced; this is not a rebase order");
  await store.broadcast(run.id, run.root, "message", "Resource notice");
  expect(currentAssignment((await store.read(run.id)).nodes[worker.id])).toEqual(before);
  await store.send(run.id, run.root, worker.id, "instruction", "Keep original ownership; run the new test", undefined, undefined, "append");
  await store.send(run.id, run.root, worker.id, "instruction", "New task; own docs.md; no commits", undefined, undefined, "replace");
  await store.broadcast(run.id, run.root, "instruction", "Read docs.md before editing");
  const state = await store.read(run.id), assignment = currentAssignment(state.nodes[worker.id])!;
  expect(assignment.text).toContain("New task; own docs.md; no commits");
  expect(assignment.text).toContain("Read docs.md before editing");
  expect(assignment.text).not.toContain("Original task");
  expect(assignment.text).not.toContain("new test");
  expect(state.nodes[worker.id].task).toBe(worker.task);
  expect(assignment.generation).toBe(4);
  await store.broadcast(run.id, run.root, "instruction", "Another complete bounded task", undefined, "replace");
  expect(currentAssignment((await store.read(run.id)).nodes[worker.id])?.text).toBe("Another complete bounded task");
}));

test("concurrent appended instructions cannot lose scope or an earlier update", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective"), worker = await store.reserve(run.id, run.root, "Worker", "Implement feature and test it");
  await Promise.all(Array.from({ length: 8 }, (_, i) => new SwarmStore(root).send(run.id, run.root, worker.id, "instruction", `Constraint ${i}`)));
  const node = (await store.read(run.id)).nodes[worker.id];
  expect(currentAssignment(node)?.generation).toBe(9);
  expect(node.directive?.text).toContain(worker.task);
  for (let i = 0; i < 8; i++) expect(node.directive?.text).toContain(`Constraint ${i}`);
  expect((await store.inbox(run.id, worker.id))[0].text).toBe(node.directive!.text);
}));

test("appends cannot revive a completed task or partially change a broadcast", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective");
  const active = await store.reserve(run.id, run.root, "Active", "Still working");
  const completed = await store.reserve(run.id, run.root, "Completed", "Finished task");
  await store.update(run.id, state => { for (const worker of [active, completed]) state.nodes[worker.id].status = "running"; });
  await store.complete(run.id, completed.id, "Done");
  const before = await store.read(run.id);
  await expect(store.send(run.id, run.root, completed.id, "instruction", "New main; rebase")).rejects.toThrow("No current assignment");
  await expect(store.broadcast(run.id, run.root, "instruction", "New main; rebase")).rejects.toThrow("No current assignment");
  expect(await store.read(run.id)).toEqual(before);
  await store.send(run.id, run.root, completed.id, "instruction", "New bounded audit", undefined, undefined, "replace");
  const state = await store.read(run.id);
  expect(state.nodes[completed.id].status).toBe("review");
  expect(state.nodes[completed.id].permission?.status).toBe("waiting-approval");
  expect(currentAssignment(state.nodes[completed.id])?.text).toBe("New bounded audit");
}));

test("assignment modes are instruction-only and invalid values leave state unchanged", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective"), worker = await store.reserve(run.id, run.root, "Worker", "Task");
  const before = await store.read(run.id);
  await expect(store.send(run.id, run.root, worker.id, "message", "Notice", undefined, undefined, "append")).rejects.toThrow("assignmentMode");
  await expect(store.broadcast(run.id, run.root, "message", "Notice", undefined, "replace")).rejects.toThrow("assignmentMode");
  await expect(store.send(run.id, run.root, worker.id, "instruction", "Notice", undefined, undefined, "invalid" as any)).rejects.toThrow("assignmentMode");
  await expect(store.broadcast(run.id, run.root, "instruction", "Notice", undefined, "invalid" as any)).rejects.toThrow("assignmentMode");
  expect(await store.read(run.id)).toEqual(before);
}));

test("model-facing tools expose modes and workers receive the full preserved assignment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-instruction-api-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = harness(); install(h.pi);
  try {
    await h.command("swarm:start", "Objective");
    const identity = h.entries.at(-1).data, store = new SwarmStore(join(root, "swarm"));
    const worker = await store.reserve(identity.run, identity.node, "Worker", "1. Code\n2. Test\nOwn feature.ts");
    await store.update(identity.run, state => { state.nodes[worker.id].status = "running"; });
    for (const name of ["swarm_send", "swarm_broadcast"]) {
      const tool = h.tools.get(name);
      expect(tool.parameters.properties.assignmentMode).toBeDefined();
      expect(tool.description).toContain("append");
      expect(tool.description).toContain("replace");
      expect(tool.description).toContain("kind=message");
    }
    await h.call("swarm_send", { to: worker.id, kind: "instruction", text: "Rebase before the next code commit" });
    expect((await store.read(identity.run)).nodes[worker.id].directive?.text).toContain(worker.task);
    await h.call("swarm_broadcast", { kind: "instruction", text: "Replace with docs audit; no commits", assignmentMode: "replace" });
    await h.call("swarm_send", { to: worker.id, kind: "instruction", text: "Check every link", assignmentMode: "append" });
    h.pi.appendEntry("pi:swarm", { run: identity.run, node: worker.id }); await h.emit("session_start");
    const deadline = Date.now() + 3000;
    while (!h.sentMessages.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(h.sentMessages[0].message.content).toContain("Replace with docs audit; no commits");
    expect(h.sentMessages[0].message.content).toContain("Check every link");
    expect(h.sentMessages[0].message.content).toContain("Read swarm_task");
    const task = (await h.call("swarm_task", {})).details;
    expect(task.currentAssignment.text).toContain("Check every link");
    expect(task.currentAssignment.text).not.toContain("Own feature.ts");
    expect(task.node.task).toBe(worker.task);
    expect(task.node.observedAssignment.generation).toBe(task.currentAssignment.generation);
    const rules = coordinationGuidelines(task.node).join("\n");
    expect(rules).toContain("does not restart completed work");
    expect(rules).toContain("receipt of a parent instruction");
  } finally {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
