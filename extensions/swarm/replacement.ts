import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, gitRaw, type Worktree } from "./git.ts";
import type { Node, Provenance } from "./state.ts";

async function fingerprint(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Replacement supports only regular files and symlinks");
  const data = stat.isSymbolicLink() ? await readlink(path) : await readFile(path);
  return createHash("sha256").update(`${stat.mode}:`).update(data).digest("hex");
}

// The stopped predecessor is the source, not the parent's potentially newer branch.
export async function inheritWorktree(node: Node, destination: string, branch: string, testedBase: string, snapshot: string): Promise<{ worktree: Worktree; provenance: Omit<Provenance, "predecessor"> }> {
  const source = node.worktree;
  if (!source || source.shared || !source.branch) throw new Error("Replacement requires a retained isolated Git worktree");
  if (await git(source.cwd, ["rev-parse", "--show-toplevel"]) !== source.cwd || await git(source.cwd, ["branch", "--show-current"]) !== source.branch) throw new Error("Predecessor worktree identity changed");
  const common = await git(source.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common !== await git(source.repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) throw new Error("Predecessor repository changed");
  const lock = join(common, "pi-swarm-prepare.lock");
  try { await mkdir(lock); } catch { throw new Error("Another swarm Git preparation holds the lock; retry after it finishes"); }
  try {
    if (await git(source.cwd, ["diff", "--name-only", "--diff-filter=U"])) throw new Error("Unresolved merges block replacement");
    const head = await git(source.cwd, ["rev-parse", "HEAD"]);
    const base = await git(source.cwd, ["rev-parse", "--verify", "--end-of-options", `${testedBase}^{commit}`]);
    if (await git(source.cwd, ["merge-base", base, head]) !== base) throw new Error("testedBase must be an ancestor of the predecessor HEAD");
    const commits = (await git(source.cwd, ["rev-list", "--reverse", `${base}..${head}`])).split("\n").filter(Boolean);
    const capture = async () => ({
      head: await git(source.cwd, ["rev-parse", "HEAD"]),
      branch: await git(source.cwd, ["branch", "--show-current"]),
      staged: await gitRaw(source.cwd, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--"]),
      unstaged: await gitRaw(source.cwd, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--"]),
      untracked: await Promise.all((await gitRaw(source.cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)
        .map(async path => ({ path, sha256: await fingerprint(join(source.cwd, path)) }))),
    });
    const captured = await capture();
    await mkdir(snapshot, { recursive: true, mode: 0o700 });
    const stagedPatch = join(snapshot, "staged.patch"), unstagedPatch = join(snapshot, "unstaged.patch");
    await writeFile(stagedPatch, captured.staged, { mode: 0o600 });
    await writeFile(unstagedPatch, captured.unstaged, { mode: 0o600 });
    for (const file of captured.untracked) {
      const target = join(snapshot, "untracked", file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await cp(join(source.cwd, file.path), target, { verbatimSymlinks: true });
    }
    const provenance = { branch: source.branch, head, testedBase: base, commits, snapshot, stagedPatch, unstagedPatch, untracked: captured.untracked };
    await writeFile(join(snapshot, "manifest.json"), JSON.stringify({ ...provenance,
      stagedSha256: createHash("sha256").update(captured.staged).digest("hex"),
      unstagedSha256: createHash("sha256").update(captured.unstaged).digest("hex"),
    }), { mode: 0o600 });
    await git(source.repository, ["worktree", "add", "-b", branch, destination, head]);
    if (captured.staged) await git(destination, ["apply", "--index", "--binary", stagedPatch]);
    if (captured.unstaged) await git(destination, ["apply", "--binary", unstagedPatch]);
    for (const file of captured.untracked) {
      const target = join(destination, file.path);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(snapshot, "untracked", file.path), target, { verbatimSymlinks: true });
      if (await fingerprint(target) !== file.sha256) throw new Error("Untracked replacement copy changed");
    }
    if (JSON.stringify(await capture()) !== JSON.stringify(captured) || captured.head !== head || captured.branch !== source.branch) throw new Error("Predecessor changed during replacement; inspect retained snapshot and worktrees");
    if (await gitRaw(destination, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD", "--"]) !== captured.staged ||
        await gitRaw(destination, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--"]) !== captured.unstaged) throw new Error("Replacement patches do not match predecessor");
    return { worktree: { cwd: await realpath(destination), repository: source.repository, branch, shared: false }, provenance };
  } finally { await rm(lock, { recursive: true }); }
}
