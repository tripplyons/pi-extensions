import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SwarmStore, currentAssignment } from "./state.ts";
import { coordinationGuidelines, treeSnapshot } from "./prompts.ts";
import { panel } from "./panel.ts";

test("current parent directives survive recovery without reviving completed assignments", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-assignment-"));
  const store = new SwarmStore(root);
  try {
    const run = await store.create("session", root, "Objective");
    const worker = await store.reserve(run.id, run.root, "Worker", "Original bounded task");
    await store.update(run.id, state => { state.nodes[worker.id].status = "running"; });
    expect(currentAssignment(worker)?.text).toBe("Original bounded task");
    await store.send(run.id, worker.id, run.root, "message", "Starting audit", "working");
    await store.complete(run.id, worker.id, "Audit done");
    let state = await store.read(run.id);
    expect(currentAssignment(state.nodes[worker.id])).toBeUndefined();
    expect(state.nodes[worker.id].activity).toBeUndefined();
    expect(coordinationGuidelines(state.nodes[run.root], state).join("\n")).toContain(`Worker (${worker.id}, revision 1)`);
    await store.review(run.id, run.root, worker.id, "accept", "Stop; no follow-on work");
    await store.send(run.id, run.root, worker.id, "instruction", "New bounded source-only audit");
    state = await new SwarmStore(root).read(run.id);
    expect(currentAssignment(state.nodes[worker.id])?.text).toBe("New bounded source-only audit");
    expect(state.nodes[worker.id].handoff?.feedback).toBe("Stop; no follow-on work");
    await store.update(run.id, next => { next.nodes[worker.id].status = "running"; });
    await store.send(run.id, worker.id, run.root, "message", "Waiting for API approval", "waiting-instructions");
    state = await store.read(run.id);
    expect(treeSnapshot(state).nodes.find(node => node.id === worker.id)?.activity?.status).toBe("waiting-instructions");
    expect(panel(state, run.root, new Set([worker.id]), 300, (_color, text) => text).join("\n")).toContain("waiting-instructions");
    expect(state.nodes[worker.id].status).toBe("running");
    await expect(store.send(run.id, run.root, worker.id, "instruction", "Work", "working")).rejects.toThrow("Only running workers report activity");
    await store.broadcast(run.id, run.root, "instruction", "Shared bounded correction");
    expect(currentAssignment((await store.read(run.id)).nodes[worker.id])?.text).toBe("Shared bounded correction");
    await store.send(run.id, worker.id, run.root, "message", "x".repeat(300), "working");
    await store.send(run.id, run.root, worker.id, "instruction", "y".repeat(300));
    state = await store.read(run.id);
    const compact = treeSnapshot(state).nodes.find(node => node.id === worker.id)!;
    expect(compact.activity?.detail).toHaveLength(241);
    expect(compact.currentAssignment?.text).toHaveLength(241);
    expect(currentAssignment(state.nodes[worker.id])?.text).toHaveLength(300);
    await store.complete(run.id, worker.id, "Second result");
    await store.review(run.id, run.root, worker.id, "request-changes", "Fix one source citation");
    expect(currentAssignment((await store.read(run.id)).nodes[worker.id])?.text).toBe("Fix one source citation");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic activity records events without guessing progress or replaying stale instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-activity-"));
  const store = new SwarmStore(root);
  try {
    const run = await store.create("session", root, "Objective");
    const worker = await store.reserve(run.id, run.root, "Worker", "Task");
    await store.update(run.id, state => { state.nodes[worker.id].status = "running"; });
    const activity = async () => (await store.read(run.id)).nodes[worker.id].activity;
    await store.send(run.id, worker.id, run.root, "message", "Source audit checkpoint");
    expect(await activity()).toMatchObject({ status: "checking-in", source: "message" });
    await store.send(run.id, worker.id, run.root, "message", "Need approval", "waiting-instructions");
    const old = await store.send(run.id, run.root, worker.id, "instruction", "First scope");
    expect(await activity()).toMatchObject({ status: "instruction-queued", source: "instruction" });
    const latest = await store.send(run.id, run.root, worker.id, "instruction", "Corrected scope");
    await store.update(run.id, state => {
      const node = state.nodes[worker.id];
      delete node.directive!.messageId;
      node.activity = { status: "waiting-instructions", detail: "Legacy wait", updated: "2020-01-01T00:00:00.000Z" };
    });
    expect(await activity()).toMatchObject({ status: "instruction-queued", detail: "Corrected scope" });
    await store.acknowledge(run.id, worker.id, old.id);
    expect(await activity()).toMatchObject({ status: "instruction-queued", detail: "Corrected scope" });
    await store.acknowledge(run.id, worker.id, latest.id);
    expect(await activity()).toMatchObject({ status: "instruction-delivered", detail: "Corrected scope" });
    await store.observeTool(run.id, worker.id, "bash");
    expect(await activity()).toMatchObject({ status: "tool-active", source: "tool-boundary", detail: "Tool boundary: bash" });
    await store.acknowledge(run.id, worker.id, latest.id);
    expect((await activity())?.status).toBe("tool-active");
    await store.send(run.id, worker.id, run.root, "message", "Dependency unavailable", "waiting-dependency");
    await store.observeTool(run.id, worker.id, "swarm_tree");
    expect((await activity())?.status).toBe("waiting-dependency");
    const [broadcast] = await store.broadcast(run.id, run.root, "instruction", "New approved scope");
    expect((await activity())?.status).toBe("instruction-queued");
    await store.acknowledge(run.id, worker.id, broadcast.id);
    expect((await activity())?.status).toBe("instruction-delivered");
    await store.complete(run.id, worker.id, "Done");
    await store.observeTool(run.id, worker.id, "bash");
    expect(await activity()).toBeUndefined();
    await store.review(run.id, run.root, worker.id, "request-changes", "Fix citation");
    expect((await activity())?.status).toBe("instruction-queued");
  } finally { await rm(root, { recursive: true, force: true }); }
});
