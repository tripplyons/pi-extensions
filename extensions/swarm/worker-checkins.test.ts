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
    state.nodes[child.id].activity = { status: "waiting-instructions", detail: "Step done;\nwhat next?", updated: new Date(240_000).toISOString(), source: "worker" };
    state.nodes[child.id].permission = { status: "waiting-approval", reason: "Step done", source: "worker", updated: new Date(240_000).toISOString() };
    state.nodes[child.id].reload = { barrier: "barrier", stage: "checkpointed" };
    const first = checks.next(state, run.root, 300_000, [{ nodeId: child.id, process: "present", state: "recent", quietSeconds: 60, jobs: [{ id: "job", status: "running", source: "bash" }, { id: "old", status: "succeeded", source: "tmux" }] }])!;
    expect(first.content).toContain("swarm_health");
    expect(first.content).toContain(`- worker (${child.id}): starting; waiting-instructions 60s ago: "Step done; what next?"; permission waiting-approval; reload checkpointed; 1 active jobs`);
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
