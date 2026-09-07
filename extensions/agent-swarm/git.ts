import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { DirtyMode, NodeRecord, PreparedWorktree, RunRecord, SwarmConfig } from "./types.ts";
import { ensureDir, runPath, safeId, worktreeDir, withLock } from "./state.ts";

export const gitRun = (cwd: string, args: string[], allowFailure = false) => {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (result.error) {
		if (allowFailure) return { ok: false, stdout: "", stderr: result.error.message, status: null };
		throw new Error(`Unable to run git: ${result.error.message}`);
	}
	if (result.status !== 0) {
		if (allowFailure) return { ok: false, stdout: result.stdout, stderr: result.stderr, status: result.status };
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.status}`);
	}
	return { ok: true, stdout: result.stdout, stderr: result.stderr, status: result.status };
};

export const gitInfo = (cwd: string): { root: string; branch: string | null; status: string } | null => {
	const root = gitRun(cwd, ["rev-parse", "--show-toplevel"], true);
	if (!root.ok) return null;
	const branch = gitRun(cwd, ["branch", "--show-current"], true);
	const status = gitRun(cwd, ["status", "--porcelain=v2", "--untracked-files=all"], true);
	return { root: root.stdout.trim(), branch: branch.ok ? branch.stdout.trim() || null : null, status: status.ok ? status.stdout : "" };
};

export const hasUnmergedState = (status: string) => status.split("\n").some((line) => line.startsWith("u ") || line.startsWith("u."));
export const isDirty = (status: string) => status.trim().length > 0;
export const isProtectedBranch = (branch: string | null, config: SwarmConfig) => branch !== null && config.protectedBranches.includes(branch);

export const branchName = (runId: string, nodeId: string) => `pi-swarm/${safeId(runId.slice(-12))}/${safeId(nodeId.slice(-12))}`;

const copyTreeEntry = (source: string, destination: string) => {
	const info = lstatSync(source);
	if (info.isSymbolicLink()) {
		ensureDir(dirname(destination));
		symlinkSync(readlinkSync(source), destination);
		return;
	}
	if (info.isDirectory()) {
		mkdirSync(destination, { recursive: true, mode: 0o700 });
		for (const entry of readdirSync(source)) copyTreeEntry(join(source, entry), join(destination, entry));
		return;
	}
	ensureDir(dirname(destination));
	copyFileSync(source, destination);
};

const relativeSafe = (value: string) => {
	const normalized = value.replaceAll("\\", "/");
	if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`Unsafe Git path: ${value}`);
	return normalized;
};

export const prepareWorktree = (run: RunRecord, parent: NodeRecord, childId: string, dirtyMode?: DirtyMode): PreparedWorktree => withLock(join(runPath(run.runId), "locks", `git-${safeId(resolve(parent.cwd))}.lock`), () => {
	const info = gitInfo(parent.cwd);
	if (!info) {
		if (dirtyMode !== "shared") throw new Error("An isolated child requires a Git repository; use dirtyMode=shared explicitly for a non-Git directory");
		return { cwd: parent.cwd, branch: null, worktreePath: null, sharedDirectory: true, mode: "shared" as const };
	}
	if (hasUnmergedState(info.status)) throw new Error("Parent Git worktree has unmerged conflicts; resolve them before spawning an isolated child");
	const dirty = isDirty(info.status);
	if (dirty && !dirtyMode) throw new Error("Parent Git worktree is dirty; choose dirtyMode=exclude, commit-parent, commit-child, or shared");
	const mode = !dirty && (dirtyMode === "commit-parent" || dirtyMode === "commit-child") ? "clean" : dirtyMode ?? "clean";
	if (mode === "shared") {
		if (isProtectedBranch(info.branch, run.config)) throw new Error(`Cannot place an agent in shared mode on protected branch ${info.branch}`);
		return { cwd: parent.cwd, branch: info.branch, worktreePath: null, sharedDirectory: true, mode };
	}
	if (mode === "commit-parent") {
		if (isProtectedBranch(info.branch, run.config)) throw new Error(`Cannot commit parent changes on protected branch ${info.branch}`);
		gitRun(parent.cwd, ["add", "-A"]);
		gitRun(parent.cwd, ["commit", "-m", `pi-swarm: hand off changes to ${childId}`]);
	}
	const patchPath = mode === "commit-child" ? join(runPath(run.runId), "transfers", `${childId}.patch`) : null;
	const untracked = mode === "commit-child"
		? gitRun(parent.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean).map(relativeSafe)
		: [];
	if (patchPath) {
		ensureDir(dirname(patchPath));
		writeFileSync(patchPath, gitRun(parent.cwd, ["diff", "--binary", "HEAD", "--"]).stdout, { mode: 0o600 });
	}
	const path = worktreeDir(run.runId, childId);
	const branch = branchName(run.runId, childId);
	ensureDir(dirname(path));
	try {
		gitRun(parent.cwd, ["worktree", "add", "-b", branch, path, "HEAD"]);
		if (mode === "commit-child") {
			if (patchPath && readFileSync(patchPath, "utf8")) gitRun(path, ["apply", "--binary", patchPath]);
			for (const entry of untracked) copyTreeEntry(join(info.root, entry), join(path, entry));
			gitRun(path, ["add", "-A"]);
			gitRun(path, ["commit", "-m", `pi-swarm: transfer parent changes to ${childId}`]);
		}
	} catch (error) {
		try { gitRun(parent.cwd, ["worktree", "remove", "--force", path], true); } catch {}
		try { gitRun(parent.cwd, ["branch", "-D", branch], true); } catch {}
		throw error;
	} finally {
		if (patchPath) rmSync(patchPath, { force: true });
	}
	return { cwd: path, branch, worktreePath: path, sharedDirectory: false, mode };
});

export const removeWorktree = (node: NodeRecord) => {
	if (!node.worktreePath || !node.branch) throw new Error(`Node ${node.nodeId} has no isolated worktree`);
	const info = gitInfo(node.worktreePath);
	if (!info) throw new Error(`Worktree is no longer available: ${node.worktreePath}`);
	if (isDirty(info.status)) throw new Error("Refusing to remove a dirty worktree");
	gitRun(info.root, ["worktree", "remove", node.worktreePath]);
};
