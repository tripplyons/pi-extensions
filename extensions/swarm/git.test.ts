import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, prepareWorktree, removeWorktree } from "./git.ts";
async function fixture(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-swarm-test-")));
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "test@example.invalid"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "file"), "original");
    await git(root, ["add", "."]); await git(root, ["commit", "-m", "Initial"]);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("dirty rejection, exclude snapshot, protected shared mode, branch retention", () => fixture(async root => {
  await writeFile(join(root, "file"), "dirty");
  const target = join(root, "child");
  await expect(prepareWorktree(root, target, "pi-swarm/test/one")).rejects.toThrow("Dirty");
  await expect(prepareWorktree(root, target, "pi-swarm/test/one", "shared")).rejects.toThrow("Protected");
  const child = await prepareWorktree(root, target, "pi-swarm/test/one", "exclude");
  expect(await readFile(join(child.cwd, "file"), "utf8")).toBe("original");
  await removeWorktree(child);
  expect(await git(root, ["branch", "--list", "pi-swarm/test/one"])).toContain("pi-swarm/test/one");
  expect(await readFile(join(root, "file"), "utf8")).toBe("dirty");
}));
test("child snapshot preserves parent HEAD and index; cleanup refuses worker changes", () => fixture(async root => {
  const head = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, "file"), "staged"); await git(root, ["add", "file"]);
  await writeFile(join(root, "file"), "working"); await writeFile(join(root, "new"), "untracked");
  const index = await git(root, ["write-tree"]);
  const child = await prepareWorktree(root, join(root, "child"), "pi-swarm/test/two", "commit-child");
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(await git(root, ["write-tree"])).toBe(index);
  expect(await readFile(join(child.cwd, "file"), "utf8")).toBe("working");
  expect(await readFile(join(child.cwd, "new"), "utf8")).toBe("untracked");
  await writeFile(join(child.cwd, "new"), "worker changes");
  await expect(removeWorktree(child)).rejects.toThrow("Dirty");
  await git(child.cwd, ["add", "-A"]); await git(child.cwd, ["commit", "-m", "Worker result"]);
  await removeWorktree(child);
}));
test("commit-parent requires unprotected branch and cleanup validates branch identity", () => fixture(async root => {
  await writeFile(join(root, "file"), "changed");
  await expect(prepareWorktree(root, join(root, "child"), "pi-swarm/test/three", "commit-parent")).rejects.toThrow("Protected");
  await git(root, ["switch", "-c", "rework"]);
  const old = await git(root, ["rev-parse", "HEAD"]);
  const child = await prepareWorktree(root, join(root, "child"), "pi-swarm/test/three", "commit-parent");
  expect(await git(root, ["rev-parse", "HEAD"])).not.toBe(old);
  await git(child.cwd, ["switch", "-c", "unexpected"]);
  await expect(removeWorktree(child)).rejects.toThrow("branch changed");
  await git(child.cwd, ["switch", child.branch!]); await removeWorktree(child);
}));
