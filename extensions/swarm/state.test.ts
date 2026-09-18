import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SwarmStore } from "./state.ts";
async function fixture(run: (store: SwarmStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-state-"));
  try { await run(new SwarmStore(root)); } finally { await rm(root, { recursive: true, force: true }); }
}
test("durable tasks, direct-relative messaging and parent-only authority", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Objective");
  const a = await store.reserve(run.id, run.root, "A", "Task A");
  const b = await store.reserve(run.id, run.root, "B", "Task B");
  await store.send(run.id, run.root, a.id, "instruction", "Do the task");
  await expect(store.send(run.id, a.id, b.id, "message", "Hi")).rejects.toThrow("relatives");
  await expect(store.send(run.id, a.id, run.root, "instruction", "Do this")).rejects.toThrow("parents");
  const other = new SwarmStore(store.root);
  expect((await other.inbox(run.id, a.id))[0].text).toBe("Do the task");
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
test("failed updates leave durable state unchanged and release the lock", () => fixture(async store => {
  const run = await store.create("session", "/tmp", "Original");
  await expect(store.update(run.id, state => { state.objective = "Partial"; throw new Error("Failed"); })).rejects.toThrow("Failed");
  expect((await store.read(run.id)).objective).toBe("Original");
  await store.reserve(run.id, run.root, "Next", "Still works");
  await expect(store.read("../../foreign")).rejects.toThrow("Invalid");
}));
