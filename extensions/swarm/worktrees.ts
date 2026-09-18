import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const exec = promisify(execFile);
export type DirtyMode = "exclude" | "commit-parent" | "commit-child" | "shared";
export type Workspace = { cwd: string; repo: string; branch?: string; shared: boolean };

async function git(cwd: string, args: string[], env = process.env) {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { env, maxBuffer: 1024 * 1024 });
  return stdout.trimEnd();
}

/** Caller supplies an unused path and branch, then persists ownership immediately. */
export async function prepareWorkspace(parent: string, destination: string, branch: string, mode?: DirtyMode): Promise<Workspace> {
  if (mode && !["exclude", "commit-parent", "commit-child", "shared"].includes(mode)) throw new Error("Invalid dirtyMode");
  let repo: string;
  try { repo = await git(parent, ["rev-parse", "--show-toplevel"]); }
  catch {
    if (mode !== "shared") throw new Error("Outside Git; explicitly select dirtyMode=shared");
    const cwd = await realpath(parent);
    return { cwd, repo: cwd, shared: true };
  }
  repo = await realpath(repo);
  const common = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const lock = join(common, "pi-rework-swarm.lock");
  try { await mkdir(lock); }
  catch (error: any) {
    if (error.code === "EEXIST") throw new Error("Swarm Git preparation is locked; retry after the current operation finishes");
    throw error;
  }
  try {
    if (await git(repo, ["diff", "--name-only", "--diff-filter=U"])) throw new Error("Unresolved merges block spawn");
    const dirty = Boolean(await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]));
    if (dirty && !mode) throw new Error("Dirty worktree; explicitly choose exclude, commit-parent, commit-child, or shared");
    const current = await git(repo, ["branch", "--show-current"]);
    if ((mode === "shared" || mode === "commit-parent") && ["main", "master"].includes(current)) throw new Error(`Protected branch: ${current}`);
    if (mode === "shared") return { cwd: repo, repo, shared: true };
    let base = "HEAD";
    if (dirty && mode === "commit-parent") {
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-m", "Checkpoint for swarm worker"]);
    }
    if (dirty && mode === "commit-child") {
      // A private index captures staged, unstaged and untracked files without
      // changing the parent's index, working tree, or branch tip.
      const temporary = await mkdtemp(join(tmpdir(), "pi-swarm-index-"));
      try {
        const index = join(temporary, "index");
        const source = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
        await copyFile(source, index);
        const env = { ...process.env, GIT_INDEX_FILE: index };
        await git(repo, ["add", "-A"], env);
        const tree = await git(repo, ["write-tree"], env);
        base = await git(repo, ["commit-tree", tree, "-p", "HEAD", "-m", "Inherit parent changes"], env);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    await git(repo, ["check-ref-format", "--branch", branch]);
    await git(repo, ["worktree", "add", "-b", branch, resolve(destination), base]);
    return { cwd: await realpath(destination), repo, branch, shared: false };
  } finally { await rm(lock, { recursive: true }); }
}

export async function preflightWorkspace(workspace: Workspace) {
  if (workspace.shared) return;
  if (!workspace.branch) throw new Error("Missing owned branch");
  const root = await realpath(await git(workspace.cwd, ["rev-parse", "--show-toplevel"]));
  if (root !== workspace.cwd) throw new Error("Worktree identity mismatch");
  if (await git(root, ["branch", "--show-current"]) !== workspace.branch) throw new Error("Worktree branch changed");
  const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common !== await git(workspace.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) throw new Error("Worktree repository changed");
  if (await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error(`Dirty worktree blocks cleanup: ${root}`);
}

export async function removeWorkspace(workspace: Workspace) {
  if (workspace.shared) return;
  await preflightWorkspace(workspace);
  // No force, branch deletion, or merge. Git also checks ignored files here.
  await git(workspace.repo, ["worktree", "remove", workspace.cwd]);
}
