import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SwarmStore } from "./state.ts";
import { handoffStatus, treeSnapshot } from "./prompts.ts";
async function fixture(run: (store: SwarmStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-state-"));
  try { await run(new SwarmStore(root)); } finally { await rm(root, { recursive: true, force: true }); }
}
test("durable tasks, sibling messages and parent-only authority", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Objective");
  const a = await store.reserve(run.id, run.root, "A", "Task A");
  const b = await store.reserve(run.id, run.root, "B", "Task B");
  await store.send(run.id, run.root, a.id, "instruction", "Do the task");
  await store.send(run.id, a.id, b.id, "message", "Shared API ready");
  expect((await store.inbox(run.id, b.id))[0].text).toBe("Shared API ready");
  await expect(store.send(run.id, a.id, b.id, "instruction", "Do this")).rejects.toThrow("parents");
  await expect(store.send(run.id, a.id, a.id, "message", "Hi")).rejects.toThrow("relay");
  await store.update(run.id, state => { state.nodes[b.id].status = "running"; });
  const nephew = await store.reserve(run.id, b.id, "Nephew", "Other task");
  await expect(store.send(run.id, a.id, nephew.id, "message", "Hi")).rejects.toThrow("relay");
  await expect(store.send(run.id, a.id, run.root, "instruction", "Do this")).rejects.toThrow("parents");
  const other = new SwarmStore(store.root);
  expect((await other.inbox(run.id, a.id))[0].text).toBe("Do the task");
  const pending = await store.inbox(run.id, a.id);
  expect(pending).toHaveLength(1); // Failed delivery remains retryable.
  await expect(store.acknowledge(run.id, b.id, pending[0].id)).rejects.toThrow("belong");
  await other.acknowledge(run.id, a.id, pending[0].id);
  expect(await store.inbox(run.id, a.id)).toEqual([]);
  expect((await other.read(run.id)).nodes[a.id].task).toBe("Task A");
  expect((await stat(join(store.path(run.id), "run.json"))).mode & 0o777).toBe(0o600);
}));
test("depth limit, descendant completion and review permissions", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Objective");
  const a = await store.reserve(run.id, run.root, "A", "Task");
  await store.update(run.id, state => { state.nodes[a.id].status = "running"; });
  const b = await store.reserve(run.id, a.id, "B", "Task");
  await store.update(run.id, state => { state.nodes[b.id].status = "running"; });
  const c = await store.reserve(run.id, b.id, "C", "Task");
  await store.update(run.id, state => { state.nodes[c.id].status = "running"; });
  await expect(store.reserve(run.id, c.id, "D", "Task")).rejects.toThrow("depth");
  await expect(store.complete(run.id, a.id, "Done")).rejects.toThrow("descendants");
  await store.complete(run.id, c.id, "Done");
  await expect(store.review(run.id, run.root, c.id, "accept", "")).rejects.toThrow("direct parent");
  await store.review(run.id, b.id, c.id, "request-changes", "Verify it");
  expect((await store.read(run.id)).nodes[c.id].status).toBe("running");
  await store.complete(run.id, c.id, "Verified"); await store.review(run.id, b.id, c.id, "accept", "");
  await store.complete(run.id, b.id, "Done"); await store.review(run.id, a.id, b.id, "accept", "");
  await store.complete(run.id, a.id, "Done");
  expect((await store.read(run.id)).nodes[a.id].status).toBe("review");
}));
test("handoff acceptance never implies code review, tests or integration", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Objective");
  const a = await store.reserve(run.id, run.root, "A", "Task");
  const b = await store.reserve(run.id, run.root, "B", "Task");
  const first = "a".repeat(40), second = "b".repeat(40);
  await expect(store.recordDelivery(run.id, run.root, a.id, first, "tested", "bun test")).rejects.toThrow("handoff");
  await store.update(run.id, state => { state.nodes[a.id].status = "running"; });
  await store.complete(run.id, a.id, "Two commits delivered");
  await expect(store.recordDelivery(run.id, b.id, a.id, first, "reviewed", "Diff inspected")).rejects.toThrow("direct parent");
  await expect(store.recordDelivery(run.id, run.root, a.id, "abc", "reviewed", "Diff inspected")).rejects.toThrow("full commit hash");
  await store.review(run.id, run.root, a.id, "accept", "Received, integration pending");
  expect((await store.read(run.id)).nodes[a.id].delivery).toBeUndefined();
  await store.recordDelivery(run.id, run.root, a.id, first, "integrated", "Cherry-picked as ccccccc; tests pending");
  await store.recordDelivery(run.id, run.root, a.id, second, "reviewed", "Independent source review");
  let records = (await new SwarmStore(store.root).read(run.id)).nodes[a.id].delivery!;
  expect(records[0].reviewed).toBeUndefined(); expect(records[0].tested).toBeUndefined();
  expect(records[0].integrated).toMatchObject({ actor: run.root, text: "Cherry-picked as ccccccc; tests pending" });
  expect(records[1].integrated).toBeUndefined();
  await store.recordDelivery(run.id, run.root, a.id, second, "tested", "bun test: 10 pass at exact revision");
  await store.recordDelivery(run.id, run.root, a.id, "result", "reviewed", "No-commit handoff review");
  await store.update(run.id, state => { state.nodes[a.id].status = "running"; });
  await store.complete(run.id, a.id, "Updated handoff");
  records = (await store.read(run.id)).nodes[a.id].delivery!;
  expect(records).toHaveLength(2); expect(records[1].tested?.text).toContain("10 pass");
}));

test("legacy retained results report unknown decisions, not a phantom review backlog", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Objective");
  const a = await store.reserve(run.id, run.root, "A", "Task");
  await store.update(run.id, state => { Object.assign(state.nodes[a.id], { status: "running", result: "Retained handoff", feedback: "Old feedback" }); });
  const restored = await store.read(run.id);
  expect(handoffStatus(restored.nodes[a.id])).toBe("unknown");
  expect(treeSnapshot(restored).nodes.find(node => node.id === a.id)).toMatchObject({ handoff: "unknown", handoffRevision: 1 });
  await store.complete(run.id, a.id, "New handoff");
  await store.review(run.id, run.root, a.id, "reject", "Rejected");
  await store.update(run.id, state => { state.nodes[a.id].status = "running"; });
  expect((await new SwarmStore(store.root).read(run.id)).nodes[a.id].handoff).toEqual({ revision: 2, status: "rejected", feedback: "Rejected" });
}));

test("concurrent replacement starts reserve only one successor", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Objective");
  const a = await store.reserve(run.id, run.root, "A", "Task");
  await store.update(run.id, state => { state.nodes[a.id].status = "running"; });
  await store.requestReplacement(run.id, run.root, a.id);
  await store.complete(run.id, a.id, "Handoff"); await store.review(run.id, run.root, a.id, "accept", "Received");
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, (_, i) =>
    new SwarmStore(store.root).reserve(run.id, run.root, `Successor ${i}`, "Task", a.id)));
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(Object.keys((await store.read(run.id)).nodes)).toHaveLength(3);
}));

test("failed updates leave durable state unchanged and release the lock", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Original");
  await expect(store.update(run.id, state => { state.objective = "Partial"; throw new Error("Failed"); })).rejects.toThrow("Failed");
  expect((await store.read(run.id)).objective).toBe("Original");
  await store.reserve(run.id, run.root, "Next", "Still works");
  await expect(store.read("../../foreign")).rejects.toThrow("Invalid");
}));
test("concurrent stores retry lock contention without losing messages or children", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Objective");
  const children = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    new SwarmStore(store.root).reserve(run.id, run.root, `Worker ${i}`, "Task")));
  await Promise.all(children.flatMap(child => [
    new SwarmStore(store.root).send(run.id, run.root, child.id, "instruction", "Finish this step"),
    new SwarmStore(store.root).send(run.id, child.id, run.root, "message", "Working"),
  ]));
  const updated = await store.read(run.id);
  expect(Object.keys(updated.nodes)).toHaveLength(13);
  expect(updated.messages).toHaveLength(24);
  expect(new Set(updated.messages.map(message => message.id)).size).toBe(24);
}));
test("stale locks time out without being removed and filesystem errors propagate", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Objective");
  const lock = join(store.path(run.id), "lock");
  await mkdir(lock);
  await expect(new SwarmStore(store.root, 50).reserve(run.id, run.root, "A", "Task")).rejects.toThrow("busy");
  expect((await stat(lock)).isDirectory()).toBe(true);
  expect(Object.keys((await store.read(run.id)).nodes)).toHaveLength(1);
  await rm(store.path(run.id), { recursive: true });
  await expect(store.update(run.id, () => {})).rejects.toThrow("ENOENT");
}));
test("broadcast targets nonterminal direct children, not siblings or grandchildren", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Objective");
  const a = await store.reserve(run.id, run.root, "A", "Task");
  const b = await store.reserve(run.id, run.root, "B", "Task");
  const c = await store.reserve(run.id, run.root, "C", "Task");
  await store.update(run.id, state => {
    state.nodes[a.id].status = "running";
    state.nodes[b.id].status = "review";
    state.nodes[c.id].status = "accepted";
  });
  const grandchild = await store.reserve(run.id, a.id, "Nested", "Task");
  const messages = await store.broadcast(run.id, run.root, "instruction", "Finish only this step");
  expect(messages.map(message => message.to)).toEqual([a.id, b.id]);
  expect(new Set(messages.map(message => message.created)).size).toBe(1);
  expect(await store.inbox(run.id, c.id)).toEqual([]);
  expect(await store.inbox(run.id, grandchild.id)).toEqual([]);
  expect((await store.broadcast(run.id, a.id, "message", "API ready")).map(message => message.to)).toEqual([grandchild.id]);
  await expect(store.broadcast(run.id, "unknown", "instruction", "Hi")).rejects.toThrow("Unknown");
  await expect(store.broadcast(run.id, run.root, "message", " ")).rejects.toThrow("text");
}));
