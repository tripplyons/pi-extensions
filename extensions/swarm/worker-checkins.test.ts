import { expect, test } from "bun:test";
import { WorkerCheckins } from "./worker-checkins.ts";
import { SwarmStore } from "./state.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parent checks recur after delivery, not while queued, and stop without active children", async () => {
  const root = await mkdtemp(join(tmpdir(), "swarm-checkins-"));
  try {
    const store = new SwarmStore(root);
    const run = await store.create("session", root, "task");
    const child = await store.reserve(run.id, run.root, "worker", "task");
    const state = await store.read(run.id);
    const checks = new WorkerCheckins();
    expect(checks.next(state, run.root, 0)).toBeUndefined();
    const first = checks.next(state, run.root, 300_000)!;
    expect(first.content).toContain("swarm_health");
    expect(checks.next(state, run.root, 900_000)).toBeUndefined();
    expect(checks.delivered(run.id, run.root, "wrong", 900_000)).toBe(false);
    expect(checks.delivered(run.id, run.root, first.queuedAt, 900_000)).toBe(true);
    expect(checks.next(state, run.root, 1_199_999)).toBeUndefined();
    expect(checks.next(state, run.root, 1_200_000)).toBeDefined();
    checks.reset();
    state.nodes[child.id].status = "review";
    expect(checks.next(state, run.root, 2_000_000)).toBeUndefined();
    state.nodes[child.id].status = "stopped";
    expect(checks.next(state, run.root, 3_000_000)).toBeUndefined();
    state.nodes[child.id].status = "running";
    expect(checks.next(state, run.root, 4_000_000)).toBeUndefined();
    expect(checks.next(state, child.id, 5_000_000)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
