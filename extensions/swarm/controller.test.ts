import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "./git.ts";
import { SwarmStore } from "./state.ts";
import { Swarm } from "./controller.ts";
import { treeSnapshot } from "./prompts.ts";
import { panel } from "./panel.ts";
test("controller connects isolation, review, jobs, restart and guarded cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-controller-"));
  const live = new Set<string>(), stoppedJobs: string[] = [];
  const launches: any[] = [];
  const workers = {
    async start(args: any) { launches.push(args); live.add(args.node); return { pane: args.node, session: join(args.directory, "session.jsonl") }; },
    async stop(node: string) { live.delete(node); }, async alive(node: string) { return live.has(node); }, async observe() { return "output"; },
  };
  try {
    const repo = join(root, "repo"); await git(root, ["init", "-b", "main", repo]);
    await git(repo, ["config", "user.name", "Test"]); await git(repo, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(repo, "file"), "original"); await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "Initial"]);
    const store = new SwarmStore(join(root, "state"));
    const run = await store.create("session", repo, "Objective");
    const swarm = new Swarm(store, workers, async node => { stoppedJobs.push(node.id); });
    const a = await swarm.spawn(run.id, run.root, "A", "Task");
    const b = await swarm.spawn(run.id, run.root, "B", "Task", undefined, { model: "openai-codex/test-model", thinking: "high", fast: true });
    expect(a.status).toBe("running");
    await expect(swarm.stop(run.id, a.id, b.id)).rejects.toThrow("direct parent");
    await store.complete(run.id, a.id, "Done"); await swarm.review(run.id, run.root, a.id, "accept", "Verified");
    expect(live.has(a.id)).toBe(false); expect(stoppedJobs).toContain(a.id);
    const checkpoint = await store.send(run.id, run.root, a.id, "instruction", "Old checkpoint; stop and wait", undefined, undefined, "replace");
    await swarm.restart(run.id, run.root, a.id, { task: "Audit the next bounded slice; no builds." });
    expect(await store.inbox(run.id, a.id)).toEqual([]);
    expect((await store.read(run.id)).messages.find(message => message.id === checkpoint.id)?.superseded).toBe(true);
    let snapshot = await new SwarmStore(store.root).read(run.id);
    expect(snapshot.nodes[a.id]).toMatchObject({ status: "running", result: "Done", directive: { text: "Audit the next bounded slice; no builds.", source: "restart" }, handoff: { revision: 1, status: "accepted", feedback: "Verified" } });
    expect(snapshot.nodes[a.id].launch).not.toHaveProperty("task");
    expect(treeSnapshot(snapshot).nodes.find(node => node.id === a.id)).toMatchObject({ handoff: "accepted", handoffRevision: 1 });
    expect(panel(snapshot, run.root, live, 300, (_, text) => text).join("\n")).toContain("handoff accepted");
    await store.complete(run.id, a.id, "Updated");
    expect((await store.read(run.id)).nodes[a.id].handoff).toMatchObject({ revision: 2, status: "awaiting-parent", submitted: expect.any(String) });
    await swarm.review(run.id, run.root, a.id, "request-changes", "Fix check");
    expect((await store.read(run.id)).nodes[a.id].handoff).toMatchObject({ revision: 2, status: "changes-requested" });
    const resumeGeneration = (await store.read(run.id)).nodes[a.id].assignmentGeneration!;
    await swarm.stop(run.id, run.root, a.id);
    await swarm.restart(run.id, run.root, a.id, { task: "Fix with the revised source, not the old check" });
    snapshot = await store.read(run.id);
    expect(snapshot.nodes[a.id].assignmentGeneration).toBe(resumeGeneration + 1);
    expect(snapshot.nodes[a.id].resume).toBeUndefined();
    expect(snapshot.nodes[a.id].handoff?.status).toBe("changes-requested");
    expect(await store.inbox(run.id, a.id)).toEqual([]);
    await store.complete(run.id, a.id, "Fixed");
    await swarm.review(run.id, run.root, a.id, "accept", "Verified again");
    // Migrate an old accepted record before restart overwrites its lifecycle status.
    await store.update(run.id, state => { delete state.nodes[a.id].handoff; });
    await swarm.restart(run.id, run.root, a.id);
    await swarm.stop(run.id, run.root, a.id);
    snapshot = await new SwarmStore(store.root).read(run.id);
    expect(snapshot.nodes[a.id]).toMatchObject({ status: "stopped", handoff: { revision: 1, status: "accepted" } });
    await swarm.restart(run.id, run.root, a.id);
    await store.complete(run.id, a.id, "Final");
    await swarm.review(run.id, run.root, a.id, "accept", "Final review");
    await swarm.stop(run.id, run.root, b.id);
    await swarm.restart(run.id, run.root, b.id); expect(live.has(b.id)).toBe(true);
    expect(launches.at(-1).model).toBe("openai-codex/test-model");
    expect(launches.at(-1).thinking).toBe("high");
    expect(launches.at(-1).fast).toBe(true);
    expect((await store.read(run.id)).nodes[b.id].launch).toEqual({ model: "openai-codex/test-model", thinking: "high", fast: true });
    const start = workers.start;
    workers.start = async () => { throw new Error("launcher unavailable"); };
    await expect(swarm.spawn(run.id, run.root, "C", "Recover launch", undefined,
      { model: "openai-codex/recovery-model", thinking: "medium" })).rejects.toThrow("launcher unavailable");
    const failed = Object.values((await store.read(run.id)).nodes).find(node => node.name === "C")!;
    expect(failed.status).toBe("failed");
    workers.start = start;
    await swarm.restart(run.id, run.root, failed.id);
    expect(launches.at(-1).model).toBe("openai-codex/recovery-model");
    expect(launches.at(-1).thinking).toBe("medium");
    await swarm.kill(run.id, run.root);
    await writeFile(join(b.worktree!.cwd, "untracked"), "keep me");
    await expect(swarm.cleanup(run.id, run.root)).rejects.toThrow("Dirty");
    expect(await git(a.worktree!.cwd, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
    await rm(join(b.worktree!.cwd, "untracked"));
    expect(await swarm.cleanup(run.id, run.root)).toHaveLength(3);
    expect((await store.read(run.id)).nodes[a.id].status).toBe("accepted");
    expect(await git(repo, ["branch", "--list", "pi-swarm/*"])).toContain(a.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
