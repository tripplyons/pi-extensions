import { expect, test } from "bun:test";
import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, gitRaw } from "./git.ts";
import { SwarmStore } from "./state.ts";
import { Swarm } from "./controller.ts";

async function fixture(check: (value: { store: SwarmStore; swarm: Swarm; run: Awaited<ReturnType<SwarmStore["create"]>>; base: string; live: Set<string>; launches: any[] }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-replacement-"));
  const live = new Set<string>(), launches: any[] = [];
  try {
    const repo = join(root, "repo"); await git(root, ["init", "-b", "main", repo]);
    await git(repo, ["config", "user.name", "Test"]); await git(repo, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(repo, "file"), "initial\n");
    await writeFile(join(repo, "binary"), Buffer.from([0, 1, 2]));
    await writeFile(join(repo, ".gitignore"), "ignored\n");
    await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "Initial"]);
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const store = new SwarmStore(join(root, "state"));
    const run = await store.create("session", repo, "Objective");
    const swarm = new Swarm(store, {
      async start(args) { launches.push(args); live.add(args.node); return { pane: args.node, session: join(args.directory, "session.jsonl") }; },
      async stop(id) { live.delete(id); }, async alive(id) { return live.has(id); }, async observe() { return ""; },
    }, async () => {});
    await check({ store, swarm, run, base, live, launches });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("replacement waits for accepted handoff and preserves commits, staged/unstaged binary WIP and untracked files", () => fixture(async ({ store, swarm, run, base, live, launches }) => {
  const predecessor = await swarm.spawn(run.id, run.root, "Claude", "Own file and binary; commit only tested changes", undefined, { model: "anthropic/claude", thinking: "high" });
  const cwd = predecessor.worktree!.cwd;
  await writeFile(join(cwd, "file"), "committed\n"); await git(cwd, ["add", "file"]); await git(cwd, ["commit", "-m", "Delivered change"]);
  const commit = await git(cwd, ["rev-parse", "HEAD"]);
  await writeFile(join(cwd, "file"), "staged\n"); await git(cwd, ["add", "file"]);
  await writeFile(join(cwd, "file"), "unstaged\n");
  await writeFile(join(cwd, "binary"), Buffer.from([0, 7, 8, 9]));
  await writeFile(join(cwd, "new file"), "untracked WIP\n");
  await symlink("file", join(cwd, "link"));
  await writeFile(join(cwd, "ignored"), "not transferred");
  const before = await gitRaw(cwd, ["status", "--porcelain=v1", "-z"]);
  await store.requestReplacement(run.id, run.root, predecessor.id);
  await store.requestReplacement(run.id, run.root, predecessor.id);
  expect((await store.inbox(run.id, predecessor.id)).filter(message => message.kind === "instruction")).toHaveLength(1);
  expect(live.has(predecessor.id)).toBe(true);
  await expect(swarm.replace(run.id, run.root, predecessor.id, "Sol", "Continue ownership", base, { model: "openai/gpt-6.1-sol" })).rejects.toThrow("live pane");
  await store.complete(run.id, predecessor.id, `Tested base ${base}; pending commit ${commit}; dirty WIP unverified`);
  await expect(swarm.replace(run.id, run.root, predecessor.id, "Sol", "Continue ownership", base, { model: "openai/gpt-6.1-sol" })).rejects.toThrow("live pane");
  await swarm.review(run.id, run.root, predecessor.id, "accept", "Handoff received, commit review pending");
  const successor = await swarm.replace(run.id, run.root, predecessor.id, "Sol", "Continue ownership", base, { model: "openai/gpt-6.1-sol", thinking: "medium" });
  expect(successor.status).toBe("running");
  expect(successor.task).toContain(predecessor.task); expect(successor.task).toContain(commit);
  expect(successor.provenance).toMatchObject({ predecessor: predecessor.id, head: commit, testedBase: base, commits: [commit] });
  expect(launches.at(-1)).toMatchObject({ model: "openai/gpt-6.1-sol", thinking: "medium" });
  expect(await git(successor.worktree!.cwd, ["rev-parse", "HEAD"])).toBe(commit);
  expect(await gitRaw(successor.worktree!.cwd, ["status", "--porcelain=v1", "-z"])).toBe(before);
  expect(await readFile(join(successor.worktree!.cwd, "file"), "utf8")).toBe("unstaged\n");
  expect(await git(successor.worktree!.cwd, ["show", ":file"])).toBe("staged");
  expect(await readFile(join(successor.worktree!.cwd, "binary"))).toEqual(Buffer.from([0, 7, 8, 9]));
  expect(await readlink(join(successor.worktree!.cwd, "link"))).toBe("file");
  await expect(readFile(join(successor.worktree!.cwd, "ignored"))).rejects.toThrow("ENOENT");
  expect(await gitRaw(cwd, ["status", "--porcelain=v1", "-z"])).toBe(before);
  expect(await git(cwd, ["rev-parse", "HEAD"])).toBe(commit);
  const manifest = JSON.parse(await readFile(join(successor.provenance!.snapshot, "manifest.json"), "utf8"));
  expect(manifest.stagedSha256).toHaveLength(64); expect(manifest.untracked).toHaveLength(2);
  await expect(swarm.replace(run.id, run.root, predecessor.id, "Duplicate", "Task", base, { model: "openai/gpt-6.1-sol" })).rejects.toThrow("already reserved");
  await expect(swarm.restart(run.id, run.root, predecessor.id)).rejects.toThrow("reserved for replacement");
  await expect(swarm.cleanup(run.id, run.root)).rejects.toThrow("predecessor worktrees are retained");
}));

test("replacement enforces authority, explicit target, accepted handoff and descendant closure", () => fixture(async ({ store, swarm, run, base }) => {
  const a = await swarm.spawn(run.id, run.root, "A", "Own a");
  const b = await swarm.spawn(run.id, run.root, "B", "Own b");
  await expect(store.requestReplacement(run.id, b.id, a.id)).rejects.toThrow("direct parent");
  await expect(swarm.replace(run.id, run.root, a.id, "Next", "Task", base, {})).rejects.toThrow("target model");
  await expect(swarm.replace(run.id, run.root, a.id, "Next", "Task", " ", { model: "openai/sol" })).rejects.toThrow("testedBase");
  await store.complete(run.id, a.id, "Handoff"); await swarm.review(run.id, run.root, a.id, "accept", "Received");
  await expect(swarm.replace(run.id, run.root, a.id, "Next", "Task", base, { model: "openai/sol" })).rejects.toThrow("Request a replacement handoff first");
  await store.requestReplacement(run.id, run.root, a.id);
  await store.update(run.id, state => { state.nodes[b.id].parent = a.id; });
  await expect(swarm.replace(run.id, run.root, a.id, "Next", "Task", base, { model: "openai/sol" })).rejects.toThrow("descendants");
}));

test("failed successor launch retains a complete snapshot and restarts with the explicit target model", () => fixture(async ({ store, swarm, run, base, launches }) => {
  const a = await swarm.spawn(run.id, run.root, "A", "Own a");
  await writeFile(join(a.worktree!.cwd, "file"), "unverified WIP\n");
  await store.requestReplacement(run.id, run.root, a.id);
  await store.complete(run.id, a.id, "Dirty work, no commit"); await swarm.review(run.id, run.root, a.id, "accept", "Received");
  const failing = new Swarm(store, {
    async start() { throw new Error("Launch unavailable"); }, async stop() {}, async alive() { return false; }, async observe() { return ""; },
  }, async () => {});
  await expect(failing.replace(run.id, run.root, a.id, "Next", "Continue", base, { model: "openai/gpt-6.1-sol", thinking: "medium" })).rejects.toThrow("Launch unavailable");
  const state = await store.read(run.id);
  const successor = state.nodes[state.nodes[a.id].replacement!.successor!];
  expect(successor.status).toBe("failed"); expect(successor.provenance?.head).toBe(base);
  expect(await readFile(join(successor.worktree!.cwd, "file"), "utf8")).toBe("unverified WIP\n");
  await swarm.restart(run.id, run.root, successor.id);
  expect(launches.at(-1)).toMatchObject({ node: successor.id, model: "openai/gpt-6.1-sol", thinking: "medium" });
  await swarm.stop(run.id, run.root, successor.id);
  await store.update(run.id, run => { delete run.nodes[successor.id].provenance; });
  await expect(swarm.restart(run.id, run.root, successor.id)).rejects.toThrow("Incomplete replacement snapshot");
}));

test("invalid tested base reserves a failed successor without changing the predecessor", () => fixture(async ({ store, swarm, run }) => {
  const a = await swarm.spawn(run.id, run.root, "A", "Own a");
  await store.requestReplacement(run.id, run.root, a.id);
  await store.complete(run.id, a.id, "No changes"); await swarm.review(run.id, run.root, a.id, "accept", "Received");
  await expect(swarm.replace(run.id, run.root, a.id, "Next", "Task", "missing-base", { model: "openai/sol" })).rejects.toThrow();
  const state = await store.read(run.id);
  const successor = state.nodes[state.nodes[a.id].replacement!.successor!];
  expect(successor.status).toBe("failed"); expect(successor.feedback).toContain("Replacement snapshot:");
  expect(await git(a.worktree!.cwd, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
  await expect(swarm.replace(run.id, run.root, a.id, "Again", "Task", "HEAD", { model: "openai/sol" })).rejects.toThrow("already reserved");
}));
