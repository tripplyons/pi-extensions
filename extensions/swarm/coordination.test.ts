import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SwarmStore, type Node } from "./state.ts";
import { ReloadBarrier, health, reviews, type OwnedJob } from "./coordination.ts";
import { treeSnapshot } from "./prompts.ts";
import { panel } from "./panel.ts";
import { packageRevision } from "./version.ts";
import { ownedJobs } from "./job-snapshot.ts";
import { Jobs } from "./jobs.ts";
import { Swarm } from "./controller.ts";
import { taskKey } from "../tasks/tasks.ts";

async function fixture(run: (store: SwarmStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-coordination-"));
  try { await run(new SwarmStore(join(root, "swarm")), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("reload checkpoints survive recovery and require all jobs stopped, readiness and explicit matching-version release", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective");
  const a = await store.reserve(run.id, run.root, "A", "Task A"), b = await store.reserve(run.id, run.root, "B", "Task B");
  await store.update(run.id, state => {
    for (const node of [a, b]) Object.assign(state.nodes[node.id], { status: "running", generation: "old", worktree: { cwd: root, repository: root, shared: true } });
  });
  await store.recordRuntime(run.id, run.root, "current");
  const live = new Set([a.id, b.id]), launches: any[] = [], active = new Map<string, OwnedJob[]>();
  const workers = {
    async start(args: any) { launches.push(args); live.add(args.node); return { pane: args.node, session: join(root, `${args.node}.jsonl`) }; },
    async stop(id: string) { live.delete(id); }, async alive(id: string) { return live.has(id); }, async observe() { return ""; },
  };
  const swarm = new Swarm(store, workers, async () => {});
  const manager = new ReloadBarrier(store, swarm, async node => active.get(node.id) ?? []);
  const barrier = await manager.request(run.id, run.root, [a.id, b.id]);
  await expect(manager.request(run.id, run.root, [a.id])).rejects.toThrow("already belongs");
  await expect(manager.restart(run.id, run.root, barrier.id)).rejects.toThrow("every worker checkpoint");
  await expect(store.complete(run.id, a.id, "Wrong handoff")).rejects.toThrow("checkpoint");
  await expect(store.send(run.id, run.root, a.id, "instruction", "Bypass", undefined, "released")).rejects.toThrow("reload release");
  await expect(swarm.restart(run.id, run.root, a.id)).rejects.toThrow("already running");
  active.set(a.id, [{ id: "job", status: "running", source: "bash" }]);
  await expect(manager.checkpoint(run.id, a.id, barrier.id, "Recovery A")).rejects.toThrow("owned jobs");
  active.clear();
  await manager.checkpoint(run.id, a.id, barrier.id, "Recovery A, no jobs, dirty files retained");
  const recovered = new SwarmStore(store.root);
  expect((await recovered.read(run.id)).nodes[a.id].reload).toMatchObject({ stage: "checkpointed", checkpoint: "Recovery A, no jobs, dirty files retained" });
  await manager.checkpoint(run.id, b.id, barrier.id, "Recovery B");
  await expect(manager.restart(run.id, a.id, barrier.id)).rejects.toThrow("barrier owner");
  await manager.restart(run.id, run.root, barrier.id);
  expect(launches).toHaveLength(2);
  const restarted = await store.read(run.id);
  for (const worker of [a, b]) {
    expect(restarted.nodes[worker.id].permission?.status).toBe("checkpoint-hold");
    expect(restarted.nodes[worker.id].generation).not.toBe("old");
    expect(restarted.nodes[worker.id].runtime).toBeUndefined();
    await expect(store.recordRuntime(run.id, worker.id, "current", "old")).rejects.toThrow("generation is stale");
  }
  const assignments = [{ nodeId: a.id, task: "New bounded A" }, { nodeId: b.id, task: "New bounded B" }];
  await expect(manager.release(run.id, run.root, barrier.id, assignments)).rejects.toThrow("readiness");
  await store.recordRuntime(run.id, a.id, "current", restarted.nodes[a.id].generation);
  await store.recordRuntime(run.id, b.id, "outdated", restarted.nodes[b.id].generation);
  await expect(manager.release(run.id, run.root, barrier.id, assignments.slice(0, 1))).rejects.toThrow("every member");
  await expect(manager.release(run.id, run.root, barrier.id, assignments)).rejects.toThrow("revisions must match");
  await store.recordRuntime(run.id, b.id, "current", restarted.nodes[b.id].generation);
  await manager.release(run.id, run.root, barrier.id, assignments);
  const released = await recovered.read(run.id);
  expect(released.barriers?.[barrier.id].phase).toBe("released");
  for (const worker of [a, b]) expect(released.nodes[worker.id]).toMatchObject({ reload: { stage: "released" }, permission: { status: "released" }, activity: { status: "instruction-queued" } });
  expect(released.nodes[a.id].directive?.text).toBe("New bounded A");
}));

test("failed reload launch preserves checkpoints and retries only workers without a live ready launch", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective");
  const a = await store.reserve(run.id, run.root, "A", "Task"), b = await store.reserve(run.id, run.root, "B", "Task");
  await store.update(run.id, state => { for (const node of [a, b]) Object.assign(state.nodes[node.id], { status: "running", worktree: { cwd: root, repository: root, shared: true } }); });
  const live = new Set([a.id, b.id]), starts: string[] = [];
  let fail = true;
  const workers = {
    async start(args: any) { starts.push(args.node); if (args.node === b.id && fail) throw new Error("launch failed"); live.add(args.node); return { pane: args.node, session: join(root, "session.jsonl") }; },
    async stop(id: string) { live.delete(id); }, async alive(id: string) { return live.has(id); }, async observe() { return ""; },
  };
  const manager = new ReloadBarrier(store, new Swarm(store, workers, async () => {}), async () => []);
  const barrier = await manager.request(run.id, run.root);
  for (const worker of [a, b]) await manager.checkpoint(run.id, worker.id, barrier.id, "Saved checkpoint");
  await expect(manager.restart(run.id, run.root, barrier.id)).rejects.toThrow("launch failed");
  expect((await store.read(run.id)).barriers?.[barrier.id]).toMatchObject({ phase: "failed", error: expect.stringContaining("launch failed") });
  fail = false; await manager.restart(run.id, run.root, barrier.id);
  expect(starts).toEqual([a.id, b.id, b.id]);
  expect((await store.read(run.id)).nodes[b.id].reload?.checkpoint).toBe("Saved checkpoint");
}));

test("reload rejects duplicate members, nested live workers, and non-parent authority", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective"), a = await store.reserve(run.id, run.root, "A", "Task");
  await store.update(run.id, state => { state.nodes[a.id].status = "running"; });
  const manager = new ReloadBarrier(store, {} as Swarm, async () => []);
  await expect(manager.request(run.id, run.root, [a.id, a.id])).rejects.toThrow("distinct");
  await expect(manager.request(run.id, a.id, [a.id])).rejects.toThrow("direct parent");
  await store.reserve(run.id, a.id, "Nested", "Task");
  await expect(manager.request(run.id, run.root, [a.id])).rejects.toThrow("nested workers first");
}));

test("permission persists separately from ordinary messages, activity and tool events", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective"), a = await store.reserve(run.id, run.root, "A", "Task");
  await store.update(run.id, state => { state.nodes[a.id].status = "running"; });
  await store.send(run.id, a.id, run.root, "message", "Waiting for approval", "waiting-instructions");
  await store.send(run.id, run.root, a.id, "message", "Acknowledged");
  await store.send(run.id, run.root, a.id, "instruction", "Discuss the dependency");
  await store.observeTool(run.id, a.id, "bash");
  await store.send(run.id, a.id, run.root, "message", "Checking in");
  expect((await store.read(run.id)).nodes[a.id]).toMatchObject({ permission: { status: "waiting-approval" }, activity: { status: "checking-in" } });
  await expect(store.send(run.id, a.id, run.root, "message", "Self release", undefined, "released")).rejects.toThrow("parent instruction");
  await store.send(run.id, run.root, a.id, "instruction", "Run only the bounded check", undefined, "released");
  expect((await new SwarmStore(store.root).read(run.id)).nodes[a.id].permission?.status).toBe("released");
  await store.broadcast(run.id, run.root, "instruction", "Wait for dependency", "waiting-dependency");
  expect((await store.read(run.id)).nodes[a.id].permission?.status).toBe("waiting-dependency");
}));

test("review queue is direct-child, oldest-first, durable and shows unknown legacy ages", () => fixture(async (store, root) => {
  const run = await store.create("session", root, "Objective"), older = await store.reserve(run.id, run.root, "Older", "Task"), newer = await store.reserve(run.id, run.root, "Newer", "Task"), legacy = await store.reserve(run.id, run.root, "Legacy", "Task");
  await store.update(run.id, state => {
    for (const worker of [older, newer, legacy]) Object.assign(state.nodes[worker.id], { status: "review", result: "Handoff" });
    state.nodes[older.id].handoff = { revision: 1, status: "awaiting-parent", submitted: "2026-01-01T00:00:00Z" };
    state.nodes[newer.id].handoff = { revision: 2, status: "awaiting-parent", submitted: "2026-01-01T00:01:00Z" };
  });
  const fresh = await new SwarmStore(store.root).read(run.id), now = Date.parse("2026-01-01T00:02:00Z");
  expect(reviews(fresh, run.root, now).map(item => [item.nodeId, item.waitingSeconds])).toEqual([[older.id, 120], [newer.id, 60], [legacy.id, null]]);
  expect(reviews(fresh, older.id, now)).toEqual([]);
  expect(treeSnapshot(fresh, false, undefined, now).reviewQueue[0].parent).toBe(run.root);
  expect(panel(fresh, run.root, new Set(), 500, (_, text) => text, now).join("\n")).toContain("review age 120s; owner root");
  await store.review(run.id, run.root, older.id, "request-changes", "One bounded fix");
  expect(reviews(await store.read(run.id), run.root)).toHaveLength(2);
}));

test("health distinguishes owned jobs, quiet activity, review waits, missing panes and unknown ownership", () => {
  const node: Node = { id: "worker", parent: "root", name: "Worker", task: "Task", depth: 1, status: "running", started: "2026-01-01T00:00:00Z" };
  const now = Date.parse("2026-01-01T00:10:00Z"), jobs: OwnedJob[] = [{ id: "job", status: "running", source: "bash" }];
  expect(health(node, true, jobs, 300, now)).toMatchObject({ process: "present", state: "quiet-with-job", quietSeconds: 600 });
  expect(health(node, true, [], 300, now).state).toBe("quiet-no-job");
  expect(health(node, false, [], 300, now).process).toBe("missing");
  expect(health(node, true, [], 300, now, "Unreadable session").state).toBe("unknown");
  expect(health({ ...node, status: "review" }, true, [], 300, now).state).toBe("awaiting-review");
  expect(health({ ...node, started: undefined }, true, [], 300, now).state).toBe("unknown");
  expect(health(node, true, [], 1000, now).state).toBe("recent");
});

test("package fingerprint changes with runtime source but not tests and appears as unknown or different in summaries", () => fixture(async (store, root) => {
  await mkdir(join(root, "lib")); await mkdir(join(root, "extensions"));
  await writeFile(join(root, "package.json"), "{}"); await writeFile(join(root, "lib", "code.ts"), "export const value = 1;");
  const first = packageRevision(root);
  await rm(join(root, "package.json")); expect(packageRevision(root)).toBe(first);
  await writeFile(join(root, "lib", "code.test.ts"), "test source"); expect(packageRevision(root)).toBe(first);
  await writeFile(join(root, "lib", "code.ts"), "export const value = 2;"); expect(packageRevision(root)).not.toBe(first);
  const run = await store.create("session", root, "Objective"), a = await store.reserve(run.id, run.root, "A", "Task");
  expect(treeSnapshot(await store.read(run.id)).nodes.find(node => node.id === a.id)?.versionState).toBe("unknown");
  await store.recordRuntime(run.id, run.root, "new"); await store.recordRuntime(run.id, a.id, "old");
  expect(treeSnapshot(await store.read(run.id)).nodes.find(node => node.id === a.id)?.versionState).toBe("differs-from-root");
}));

test("owned job snapshots read all worker task references without marking live records lost", () => fixture(async (_store, root) => {
  const session = join(root, "worker.jsonl"), id = "11111111-1111-1111-1111-111111111111";
  await mkdir(join(root, "minimax", "tasks"), { recursive: true });
  const path = join(root, "minimax", "tasks", `${id}.json`), content = JSON.stringify({ task_id: id, status: "running" });
  await writeFile(path, content);
  await writeFile(session, [JSON.stringify({ type: "session", id: "worker-session" }), JSON.stringify({ type: "custom", customType: taskKey, data: id })].join("\n"));
  const node: Node = { id: "worker", name: "Worker", task: "Task", depth: 1, status: "running", session };
  expect(await ownedJobs(root, new Jobs(join(root, "jobs")), node)).toEqual([{ id, status: "running", source: "bash" }]);
  expect(await readFile(path, "utf8")).toBe(content);
  await expect(ownedJobs(root, new Jobs(join(root, "jobs")), { ...node, session: undefined })).rejects.toThrow("ownership is unknown");
}));
