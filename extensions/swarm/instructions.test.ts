import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SwarmStore, currentAssignment, instructionUpdate, pendingMessages } from "./state.ts";
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

test("requested changes keep the assignment the handoff answered, including an append the worker never read", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective");
  const worker = await store.reserve(run.id, run.root, "Worker", "Own parser.ts");
  await store.update(run.id, state => { state.nodes[worker.id].status = "running"; });
  // The append arrives while the worker is writing its handoff, so it is never delivered.
  await store.send(run.id, run.root, worker.id, "instruction", "Also cover the empty-input case");
  await store.complete(run.id, worker.id, "Parser done");
  expect(currentAssignment((await store.read(run.id)).nodes[worker.id])).toBeUndefined();
  await store.review(run.id, run.root, worker.id, "request-changes", "The appended instruction is not covered");
  const state = await store.read(run.id), node = state.nodes[worker.id];
  expect(currentAssignment(node)?.text).toBe("Own parser.ts\n\nAdditional parent instruction (preserve the task above; this update takes precedence where it conflicts):\nAlso cover the empty-input case\n\nParent review of handoff revision 1 requests changes (preserve the task above; this feedback takes precedence where it conflicts):\nThe appended instruction is not covered");
  expect(node.activity?.detail).toBe("The appended instruction is not covered");
  const [resume] = pendingMessages(state, worker.id);
  expect(resume.id).toBe(node.resume!.messageId);
  expect(instructionUpdate(state, resume)).toEqual({ text: "Also cover the empty-input case\n\nThe appended instruction is not covered", whole: false });
  expect((await store.sent(run.id, run.root, worker.id)).map(entry => [entry.delivery, entry.text])).toEqual([
    ["queued", "The appended instruction is not covered"], ["superseded", "Also cover the empty-input case"],
  ]);

  // A handoff saved before this record existed resumes on the feedback alone.
  await store.complete(run.id, worker.id, "Second pass");
  await store.update(run.id, next => { delete next.nodes[worker.id].answered; });
  await store.review(run.id, run.root, worker.id, "request-changes", "One more fix");
  expect(currentAssignment((await store.read(run.id)).nodes[worker.id])?.text).toBe("One more fix");
}));

test("a send repeated after a lost tool result is not delivered or appended twice", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective");
  const a = await store.reserve(run.id, run.root, "A", "Own a.ts"), b = await store.reserve(run.id, run.root, "B", "Own b.ts");
  await store.update(run.id, state => { for (const worker of [a, b]) state.nodes[worker.id].status = "running"; });
  const first = await store.send(run.id, run.root, a.id, "instruction", "Rebase onto abc123");
  const assignment = currentAssignment((await store.read(run.id)).nodes[a.id])!;
  // The worker may have read the first copy already; the assignment still ends with it.
  await store.acknowledge(run.id, a.id, first.id);
  const again = await store.send(run.id, run.root, a.id, "instruction", "Rebase onto abc123", undefined, "released");
  expect(again).toMatchObject({ id: first.id, duplicate: true, note: expect.stringContaining("nothing was sent again") });
  let state = await store.read(run.id);
  expect(currentAssignment(state.nodes[a.id])).toEqual(assignment);
  expect(state.nodes[a.id].permission).toMatchObject({ status: "released", source: "parent" });
  expect(state.messages.filter(message => message.to === a.id)).toHaveLength(1);

  // A broadcast skips only the recipients that already hold it.
  const broadcast = await store.broadcast(run.id, run.root, "instruction", "Rebase onto abc123");
  expect(broadcast.map(message => [message.to, message.duplicate ?? false])).toEqual([[a.id, true], [b.id, false]]);
  expect(await store.broadcast(run.id, run.root, "message", "Base moved")).toHaveLength(2);
  expect((await store.broadcast(run.id, run.root, "message", "Base moved")).every(message => message.duplicate)).toBe(true);
  expect(await store.inbox(run.id, b.id)).toHaveLength(2);

  // Once the worker has answered, the same words are a new instruction.
  await store.send(run.id, a.id, run.root, "message", "Rebased; anything else?");
  expect((await store.send(run.id, run.root, a.id, "instruction", "Rebase onto abc123")).duplicate).toBeUndefined();
  state = await store.read(run.id);
  expect(currentAssignment(state.nodes[a.id])!.text.split("Rebase onto abc123")).toHaveLength(3);
  // A delivered message may be repeated on purpose; a reworded or different-mode instruction is new.
  const ping = await store.send(run.id, run.root, b.id, "message", "Status?");
  await store.acknowledge(run.id, b.id, ping.id);
  expect((await store.send(run.id, run.root, b.id, "message", "Status?")).duplicate).toBeUndefined();
  expect((await store.send(run.id, run.root, a.id, "instruction", "Rebase onto abc123", undefined, undefined, "replace")).duplicate).toBeUndefined();
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

test("an appended instruction is delivered and reported without repeating the assignment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-instruction-size-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = harness(); install(h.pi);
  try {
    await h.command("swarm:start", "Objective");
    const identity = h.entries.at(-1).data, store = new SwarmStore(join(root, "swarm"));
    const task = `Own feature.ts. ${"Detail. ".repeat(600)}`;
    const worker = await store.reserve(identity.run, identity.node, "Worker", task);
    await store.update(identity.run, state => { state.nodes[worker.id].status = "running"; });
    const first = (await h.call("swarm_send", { to: worker.id, kind: "instruction", text: "Rebase first" })).details;
    expect(first).toMatchObject({ to: worker.id, kind: "instruction", assignmentMode: "append" });
    expect(first.text).toBeUndefined();
    expect(first.assignmentChars).toBeGreaterThan(task.length);
    await h.call("swarm_send", { to: worker.id, kind: "instruction", text: "Then run the linter" });
    await h.call("swarm_send", { to: worker.id, kind: "message", text: "FYI" });
    // A sender whose call was interrupted can check delivery instead of sending again.
    expect((await h.call("swarm_sent", { to: worker.id })).details.map((entry: any) => [entry.kind, entry.delivery, entry.text])).toEqual([
      ["message", "queued", "FYI"], ["instruction", "queued", "Then run the linter"], ["instruction", "superseded", "Rebase first"],
    ]);
    await expect(h.call("swarm_sent", { to: "missing" })).rejects.toThrow("Unknown node");

    h.pi.appendEntry("pi:swarm", { run: identity.run, node: worker.id }); await h.emit("session_start");
    const deadline = Date.now() + 3000;
    while ((!h.sentMessages.length || (await store.inbox(identity.run, worker.id)).length) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(h.sentMessages).toHaveLength(1);
    const content = h.sentMessages[0].message.content;
    // The append superseded before delivery still reaches the worker.
    expect(content).toContain("Rebase first\n\nThen run the linter\n\nThis text was appended to your assignment. Read swarm_task");
    expect(content).toContain("FYI");
    expect(content).toEndWith("[End of swarm message. Any text after this line has a different sender.]");
    expect(content).not.toContain("Detail.");
    expect((await store.sent(identity.run, identity.node, worker.id, 2)).map(entry => entry.delivery)).toEqual(["delivered", "delivered"]);

    // Pi holds the instruction until the next tool boundary; a handoff written meanwhile would miss it.
    await expect(h.call("swarm_complete", { result: "Done" })).rejects.toThrow("Read swarm_task, act on the current assignment, then submit the handoff");
    const reply = await h.call("swarm_task", {});
    expect(reply.details.currentAssignment.text).toStartWith(task);
    expect(reply.details.currentAssignment.text).toEndWith("Then run the linter");
    expect(reply.details.node.task).toBe("[the start of currentAssignment.text]");
    expect(reply.details.node.directive.text).toBe("[currentAssignment.text]");
    expect(reply.details.node.permission.reason.length).toBeLessThan(400);
    // The assignment appears once, so the result stays near its size.
    expect(reply.content[0].text.length).toBeLessThan(reply.details.currentAssignment.text.length + 3000);
  } finally {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
