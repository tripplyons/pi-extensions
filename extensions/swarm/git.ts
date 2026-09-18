import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const exec = promisify(execFile);
export type DirtyMode = "exclude" | "commit-parent" | "commit-child" | "shared";
export type Worktree = { cwd: string; repository: string; branch?: string; shared: boolean };
export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return (await exec("git", ["-C", cwd, ...args], { env: env ?? process.env, maxBuffer: 4 * 1024 * 1024 })).stdout.trimEnd();
}

export async function prepareWorktree(parent: string, destination: string, branch: string, mode?: DirtyMode): Promise<Worktree> {
  const cwd = await realpath(parent);
  let repository: string;
  try { repository = await git(cwd, ["rev-parse", "--show-toplevel"]); }
  catch {
    if (mode !== "shared") throw new Error("Outside Git: explicitly choose dirtyMode=shared");
    return { cwd, repository: cwd, shared: true };
  }
  if (!/^pi-swarm\/[a-zA-Z0-9/-]+$/.test(branch)) throw new Error("Invalid generated swarm branch");
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const lock = join(common, "pi-swarm-prepare.lock");
  try { await mkdir(lock); } catch { throw new Error("Another swarm Git preparation holds the lock; retry after it finishes"); }
  try {
    if (await git(cwd, ["diff", "--name-only", "--diff-filter=U"])) throw new Error("Unresolved merges block spawn");
    const dirty = !!await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (dirty && !mode) throw new Error("Dirty worktree: choose exclude, commit-parent, commit-child, or shared");
    if (mode && !["exclude", "commit-parent", "commit-child", "shared"].includes(mode)) throw new Error("Invalid dirty mode");
    const current = await git(cwd, ["branch", "--show-current"]);
    if ((mode === "shared" || mode === "commit-parent") && ["main", "master"].includes(current)) throw new Error(`Protected branch: ${current}`);
    if (mode === "shared") return { cwd, repository, shared: true };
    let revision = await git(cwd, ["rev-parse", "HEAD"]);
    if (dirty && mode === "commit-parent") {
      await git(repository, ["add", "-A"]);
      await git(repository, ["commit", "-m", "Checkpoint for swarm worker"]);
      revision = await git(repository, ["rev-parse", "HEAD"]);
    }
    if (dirty && mode === "commit-child") {
      // A private index snapshots tracked/untracked files without touching the parent's index or branch.
      const temporary = await mkdtemp(join(tmpdir(), "pi-swarm-index-"));
      try {
        const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
        await git(repository, ["read-tree", "HEAD"], env);
        await git(repository, ["add", "-A"], env);
        const tree = await git(repository, ["write-tree"], env);
        revision = await git(repository, ["commit-tree", tree, "-p", revision, "-m", "Inherit parent changes"], env);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    await git(repository, ["worktree", "add", "-b", branch, destination, revision]);
    return { cwd: await realpath(destination), repository, branch, shared: false };
  } finally { await rm(lock, { recursive: true }); }
}

export async function preflightWorktree(worktree: Worktree) {
  if (worktree.shared) return;
  if (!worktree.branch || await git(worktree.cwd, ["rev-parse", "--show-toplevel"]) !== worktree.cwd) throw new Error("Worktree identity mismatch");
  if (await git(worktree.cwd, ["branch", "--show-current"]) !== worktree.branch) throw new Error("Worktree branch changed");
  const actual = await git(worktree.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const expected = await git(worktree.repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (actual !== expected) throw new Error("Worktree repository mismatch");
  if (await git(worktree.cwd, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Dirty worktree blocks cleanup");
}
export async function removeWorktree(worktree: Worktree) {
  if (worktree.shared) return;
  await preflightWorktree(worktree);
  await git(worktree.repository, ["worktree", "remove", worktree.cwd]);
  // Keep the branch and commits for review/recovery; never merge implicitly.
}
