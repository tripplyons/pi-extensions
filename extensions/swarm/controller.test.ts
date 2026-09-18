import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "./git.ts";
import { SwarmStore } from "./state.ts";
import { Swarm } from "./controller.ts";
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
    const swarm = new Swarm(store, workers, [], async node => { stoppedJobs.push(node.id); });
    const a = await swarm.spawn(run.id, run.root, "A", "Task");
    const b = await swarm.spawn(run.id, run.root, "B", "Task", undefined, { model: "openai-codex/test-model", thinking: "high" });
    expect(a.status).toBe("running");
    await expect(swarm.stop(run.id, a.id, b.id)).rejects.toThrow("direct parent");
    await store.complete(run.id, a.id, "Done"); await swarm.review(run.id, run.root, a.id, "accept", "Verified");
    expect(live.has(a.id)).toBe(false); expect(stoppedJobs).toContain(a.id);
    await swarm.stop(run.id, run.root, b.id);
    await swarm.restart(run.id, run.root, b.id); expect(live.has(b.id)).toBe(true);
    expect(launches.at(-1).model).toBe("openai-codex/test-model");
    expect(launches.at(-1).thinking).toBe("high");
    expect((await store.read(run.id)).nodes[b.id].launch).toEqual({ model: "openai-codex/test-model", thinking: "high" });
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
