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
  const workers = {
    async start(args: any) { live.add(args.node); return { pane: args.node, session: join(args.directory, "session.jsonl") }; },
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
    const b = await swarm.spawn(run.id, run.root, "B", "Task");
    expect(a.status).toBe("running");
    await expect(swarm.stop(run.id, a.id, b.id)).rejects.toThrow("direct parent");
    await store.complete(run.id, a.id, "Done"); await swarm.review(run.id, run.root, a.id, "accept", "Verified");
    expect(live.has(a.id)).toBe(false); expect(stoppedJobs).toContain(a.id);
    await swarm.stop(run.id, run.root, b.id);
    await swarm.restart(run.id, run.root, b.id); expect(live.has(b.id)).toBe(true);
    await swarm.kill(run.id, run.root);
    await writeFile(join(b.worktree!.cwd, "untracked"), "keep me");
    await expect(swarm.cleanup(run.id, run.root)).rejects.toThrow("Dirty");
    expect(await git(a.worktree!.cwd, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
    await rm(join(b.worktree!.cwd, "untracked"));
    expect(await swarm.cleanup(run.id, run.root)).toHaveLength(2);
    expect((await store.read(run.id)).nodes[a.id].status).toBe("accepted");
    expect(await git(repo, ["branch", "--list", "pi-swarm/*"])).toContain(a.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
