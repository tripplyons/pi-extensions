import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { NodeRecord, RunRecord } from "./types.ts";
import { ensureDir, runDir, worktreeDir } from "./state.ts";

interface GitProcessResult { error?: Error; status: number | null; stdout: string; stderr: string }
type GitExecutor = (command: string, args: string[], options: { encoding: "utf8"; env: NodeJS.ProcessEnv; input?: string }) => GitProcessResult;

export const createGitRunner = (execute: GitExecutor = spawnSync as GitExecutor) => (cwd: string, args: string[], allowFailure = false, input?: string) => {
	const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	environment.GIT_TERMINAL_PROMPT = "0";
	environment.GIT_OPTIONAL_LOCKS = "0";
	const options = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-C", cwd];
	const run = (command: string[], input?: string) => execute("git", [...options, ...command], { encoding: "utf8", env: environment, input });
	// Only commands which populate or stage the worktree can invoke a content
	// filter. Avoid doing several full-tree attribute scans for read-only Git
	// queries and for commit itself; commitResult's preceding `add` is the
	// security boundary. This also keeps integration comfortably below the tool
	// timeout on repositories with cold filesystem caches.
	const mayInvokeFilters = new Set(["add", "apply", "checkout", "merge", "read-tree", "reset", "restore", "switch", "worktree"]);
	if (mayInvokeFilters.has(args[0])) {
		const filters = run(["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]);
		if (filters.error) throw filters.error;
		if (filters.status !== 0 && filters.status !== 1) throw new Error(`Cannot inspect Git filters: ${filters.stderr.trim()}`);
		const drivers = new Set(filters.stdout.trim().split("\n").filter(Boolean).map((key) => key.slice("filter.".length, key.lastIndexOf("."))));
		for (const driver of drivers) {
			for (const setting of ["clean", "smudge", "process"]) options.push("-c", `filter.${driver}.${setting}=`);
			options.push("-c", `filter.${driver}.required=false`);
		}
		const mergeDrivers = run(["config", "--null", "--name-only", "--get-regexp", "^merge\\..*\\.driver$"]);
		if (mergeDrivers.error) throw mergeDrivers.error;
		if (mergeDrivers.status !== 0 && mergeDrivers.status !== 1) throw new Error(`Cannot inspect Git merge drivers: ${mergeDrivers.stderr.trim()}`);
		for (const key of new Set(mergeDrivers.stdout.split("\0").filter(Boolean))) options.push("-c", `${key}=/usr/bin/false`);
		const files = run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
		if (files.status !== 0) throw new Error(`Cannot inspect Git worktree paths: ${files.stderr.trim()}`);
		const head = run(["ls-tree", "-r", "--name-only", "-z", "HEAD"]);
		const paths = [...new Set((files.stdout + head.stdout).split("\0").filter(Boolean))].join("\0") + "\0";
		for (const source of [[], ["--cached"], ...(head.status === 0 ? [["--source=HEAD"]] : [])]) {
			const attributes = run(["check-attr", ...source, "-z", "--stdin", "filter"], paths);
			if (attributes.status !== 0) throw new Error(`Cannot inspect Git attributes: ${attributes.stderr.trim()}`);
			const values = attributes.stdout.split("\0");
			for (let index = 2; index < values.length; index += 3) {
				if (values[index] !== "unspecified" && values[index] !== "unset") throw new Error(`Git content filters are unsupported: ${values[index - 2]}`);
			}
		}
	}
	const command = args[0] === "diff" || args[0] === "show" ? [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
	const result = run(command, input);
	if (result.error) throw result.error;
	if (result.status !== 0 && !allowFailure) throw new Error(result.stderr.trim() || result.stdout.trim() || `git exited ${result.status}`);
	return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
};

type GitRunner = ReturnType<typeof createGitRunner>;
let activeGitRunner: GitRunner = createGitRunner();
export const git: GitRunner = (...args) => activeGitRunner(...args);
export const setGitRunnerForTests = (runner?: GitRunner) => { activeGitRunner = runner ?? createGitRunner(); };
export const generatedBranch = (runId: string, nodeId: string) => `pi-swarm/${runId.slice(-12)}/${nodeId.slice(-12)}`;

function assertWorktreePath(node: NodeRecord) {
	if (!lstatSync(node.cwd).isDirectory() || realpathSync(node.cwd) !== node.cwd) throw new Error(`Worktree path changed: ${node.cwd}`);
}

export function assertSupportedAttributes(values: string[], kind: "filter" | "merge") {
	const supported = kind === "filter" ? new Set(["unspecified", "unset"]) : new Set(["unspecified", "set", "unset", "text", "binary", "union"]);
	for (let index = 2; index < values.length; index += 3) {
		if (!supported.has(values[index]!)) throw new Error(kind === "filter"
			? `Git content filters are unsupported: ${values[index - 2]}`
			: `Custom Git merge drivers are unsupported: ${values[index - 2]} uses ${values[index]}`);
	}
}

function assertRevisionFilters(cwd: string, revision: string) {
	const paths = git(cwd, ["ls-tree", "-r", "--name-only", "-z", revision]).stdout;
	const values = git(cwd, ["check-attr", `--source=${revision}`, "-z", "--stdin", "filter"], false, paths).stdout.split("\0");
	assertSupportedAttributes(values, "filter");
}

function assertMergeDrivers(cwd: string, revision: string) {
	const incoming = git(cwd, ["ls-tree", "-r", "--name-only", "-z", revision]).stdout;
	const current = git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).stdout;
	const paths = [...new Set((incoming + current).split("\0").filter(Boolean))].join("\0") + "\0";
	for (const source of [[], ["--cached"], ["--source=HEAD"], [`--source=${revision}`]]) {
		const values = git(cwd, ["check-attr", ...source, "-z", "--stdin", "merge"], false, paths).stdout.split("\0");
		assertSupportedAttributes(values, "merge");
	}
}

export const repositoryInfo = (cwd: string) => {
	const paths = git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], true);
	if (!paths.ok) throw new Error("agent-swarm requires a Git repository");
	const [root, commonDir, ...unexpectedPaths] = paths.stdout.trim().split("\n");
	if (!root || !commonDir || unexpectedPaths.length) throw new Error("Cannot inspect Git repository paths");
	const status = git(cwd, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]).stdout;
	const lines = status.split("\n");
	const oid = lines.find(line => line.startsWith("# branch.oid "))?.slice("# branch.oid ".length);
	const branchHead = lines.find(line => line.startsWith("# branch.head "))?.slice("# branch.head ".length);
	if (!oid || oid === "(initial)" || !branchHead) throw new Error("Cannot inspect Git HEAD");
	const changes = lines.filter(line => line && !line.startsWith("# "));
	return {
		root,
		commonDir,
		branch: branchHead === "(detached)" ? null : branchHead,
		head: oid,
		status: changes.length ? `${changes.join("\n")}\n` : "",
	};
};

const copyEntry = (source: string, destination: string) => {
	const info = lstatSync(source);
	if (info.isSymbolicLink()) { ensureDir(dirname(destination)); symlinkSync(readlinkSync(source), destination); return; }
	if (info.isDirectory()) { mkdirSync(destination, { recursive: true, mode: 0o700 }); for (const entry of readdirSync(source)) copyEntry(join(source, entry), join(destination, entry)); return; }
	ensureDir(dirname(destination)); copyFileSync(source, destination);
};

export const createWorktree = (run: RunRecord, parent: NodeRecord, childId: string, includeDirty: boolean, revision?: string) => {
	assertWorktreePath(parent);
	const info = repositoryInfo(parent.cwd);
	if (revision && !/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("Snapshots require an exact commit");
	assertRevisionFilters(parent.cwd, revision ?? info.head);
	if (!revision && info.status.trim() && !includeDirty) throw new Error("Parent worktree is dirty; set includeDirty=true to copy its snapshot without changing it");
	const path = worktreeDir(run.runId, childId);
	const branch = generatedBranch(run.runId, childId);
	git(parent.cwd, ["worktree", "add", "-b", branch, path, revision ?? "HEAD"]);
	try {
		if (includeDirty && info.status.trim()) {
			const patch = git(parent.cwd, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"]).stdout;
			if (patch) { const patchPath = join(runDir(run.runId), "control", `transfer-${childId}.patch`); ensureDir(dirname(patchPath)); writeFileSync(patchPath, patch); try { git(path, ["apply", "--binary", patchPath]); } finally { rmSync(patchPath, { force: true }); } }
			const untracked = git(parent.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean);
			for (const relative of untracked) {
				if (relative.split("/").includes("..")) throw new Error(`Unsafe Git path: ${relative}`);
				copyEntry(join(info.root, relative), join(path, relative));
			}
		}
		return { path: realpathSync(path), branch, baseCommit: revision ?? info.head };
	} catch (error) {
		git(run.gitRoot, ["worktree", "remove", "--force", path], true);
		git(run.gitRoot, ["branch", "-D", branch], true);
		throw error;
	}
};

function assertNoGitOperation(node: NodeRecord) {
	assertWorktreePath(node);
	const names = ["index.lock", "HEAD.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "rebase-merge", "rebase-apply"];
	const paths = git(node.cwd, ["rev-parse", "--path-format=absolute", ...names.flatMap(name => ["--git-path", name])]).stdout.trim().split("\n");
	if (paths.length !== names.length) throw new Error("Cannot inspect Git operation paths");
	for (const path of paths) if (existsSync(path)) throw new Error(`Git operation is in progress: ${path}`);
}

export function assertCleanWorktree(node: NodeRecord) {
	assertNoGitOperation(node);
	const info = repositoryInfo(node.cwd);
	if (info.status.trim()) throw new Error(`Worktree is dirty: ${node.nodeId}`);
	return info;
}

export function integrateResult(run: RunRecord, manager: NodeRecord, child: NodeRecord) {
	const rootCoordinator = manager.role === "coordinator" && manager.nodeId === run.rootNodeId && manager.parentId === null && manager.runId === run.runId && manager.cwd === run.gitRoot;
	const generatedManager = manager.role === "manager" && manager.branch === generatedBranch(manager.runId, manager.nodeId) && !run.config.protectedBranches.includes(manager.branch);
	if (!rootCoordinator && !generatedManager) throw new Error("Integration requires the root coordinator checkout or a generated manager branch");
	if (child.parentId !== manager.nodeId || child.runId !== manager.runId || child.status !== "completed" || child.review?.action !== "accept" || !child.result?.commit || !child.baseCommit) throw new Error("Integration requires an accepted direct-child commit");
	if (child.integrationCommit) return child.integrationCommit;
	assertWorktreePath(manager);
	assertWorktreePath(child);
	assertRevisionFilters(manager.cwd, child.result.commit);
	const destination = assertCleanWorktree(manager);
	const source = assertCleanWorktree(child);
	if (destination.branch !== manager.branch || source.head !== child.result.commit) throw new Error("Reviewed Git state has changed");
	assertMergeDrivers(manager.cwd, child.result.commit);
	if (!git(manager.cwd, ["merge-base", "--is-ancestor", child.baseCommit, destination.head], true).ok) throw new Error("Child base is not an ancestor of the manager branch");
	const merged = git(manager.cwd, ["merge", "--no-ff", "--no-edit", child.result.commit], true);
	if (!merged.ok) {
		git(manager.cwd, ["merge", "--abort"], true);
		const restored = assertCleanWorktree(manager);
		if (restored.head !== destination.head) throw new Error("Integration failed and rollback requires inspection");
		throw new Error(`Integration conflict: ${merged.stderr.trim() || merged.stdout.trim()}`);
	}
	return assertCleanWorktree(manager).head;
}

export const commitResult = (node: NodeRecord, message: string) => {
	if (node.role !== "worker" && node.role !== "manager") throw new Error("Only workers and managers create result commits");
	assertNoGitOperation(node);
	const info = repositoryInfo(node.cwd);
	if (node.branch !== generatedBranch(node.runId, node.nodeId) || info.branch !== node.branch) throw new Error("Result commits require the node's generated branch");
	git(node.cwd, ["add", "-A"]);
	const staged = git(node.cwd, ["diff", "--cached", "--quiet"], true);
	if (!staged.ok) git(node.cwd, ["commit", "-m", message]);
	const commit = git(node.cwd, ["rev-parse", "HEAD"]).stdout.trim();
	if (git(node.cwd, ["status", "--porcelain=v2", "--untracked-files=all"]).stdout.trim()) throw new Error("Result worktree remained dirty after commit");
	return commit;
};
