import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace, removeWorkspace } from "./worktrees.ts";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(run: (root: string, repo: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-worktree-test-"));
  const repo = join(root, "repo"); await mkdir(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "file"), "original"); git(repo, "add", "."); git(repo, "commit", "-m", "Initial");
  try { await run(root, repo); } finally { await rm(root, { recursive: true, force: true }); }
}
test("dirty choices, protected branches, child snapshots leave parent untouched", () => fixture(async (root, repo) => {
  await writeFile(join(repo, "file"), "staged"); git(repo, "add", "file");
  await writeFile(join(repo, "file"), "unstaged"); await writeFile(join(repo, "new file"), "untracked");
  const head = git(repo, "rev-parse", "HEAD"); const staged = git(repo, "diff", "--cached");
  await expect(prepareWorkspace(repo, join(root, "a"), "worker-a")).rejects.toThrow("Dirty worktree");
  await expect(prepareWorkspace(repo, join(root, "a"), "worker-a", "shared")).rejects.toThrow("Protected");
  await expect(prepareWorkspace(repo, join(root, "a"), "worker-a", "commit-parent")).rejects.toThrow("Protected");
  const child = await prepareWorkspace(repo, join(root, "child"), "worker-child", "commit-child");
  expect(await readFile(join(child.cwd, "file"), "utf8")).toBe("unstaged");
  expect(await readFile(join(child.cwd, "new file"), "utf8")).toBe("untracked");
  expect(git(repo, "rev-parse", "HEAD")).toBe(head); expect(git(repo, "diff", "--cached")).toBe(staged);
  expect(git(child.cwd, "status", "--porcelain")).toBe("");
  await removeWorkspace(child); expect(git(repo, "branch", "--list", "worker-child")).toContain("worker-child");
  const excluded = await prepareWorkspace(repo, join(root, "excluded"), "worker-excluded", "exclude");
  expect(await readFile(join(excluded.cwd, "file"), "utf8")).toBe("original");
  await writeFile(join(excluded.cwd, "precious"), "keep");
  await expect(removeWorkspace(excluded)).rejects.toThrow("Dirty worktree");
  expect(await readFile(join(excluded.cwd, "precious"), "utf8")).toBe("keep");
}));
test("explicit parent checkpoints and shared directories", () => fixture(async (root, repo) => {
  git(repo, "switch", "-c", "work"); await writeFile(join(repo, "file"), "checkpoint");
  const child = await prepareWorkspace(repo, join(root, "child"), "worker", "commit-parent");
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(repo, "rev-parse", "HEAD")).toBe(git(child.cwd, "rev-parse", "HEAD"));
  await removeWorkspace(child);
  await expect(prepareWorkspace(root, join(root, "other"), "unused")).rejects.toThrow("Outside Git");
  const shared = await prepareWorkspace(root, join(root, "other"), "unused", "shared");
  expect(shared.shared).toBe(true); await removeWorkspace(shared);
}));
