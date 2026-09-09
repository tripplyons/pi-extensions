import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitResult, createWorktree, git, integrateResult, repositoryInfo } from "./git.ts";
import { makeNode } from "./runtime.ts";
import { defaultConfig, type RunRecord } from "./types.ts";

const macTest = process.platform === "darwin" ? test : test.skip;

macTest("integration must not execute a host merge driver selected through worker attributes", () => {
	const source = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-merge-source-")));
	const state = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-merge-state-")));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = state;
	try {
		git(source, ["init", "-b", "main"]);
		git(source, ["config", "user.name", "Swarm Test"]);
		git(source, ["config", "user.email", "swarm@example.invalid"]);
		writeFileSync(join(source, "feature"), "base\n");
		git(source, ["add", "feature"]); git(source, ["commit", "-m", "Initialize fixture"]);
		const escaped = join(source, "merge-side-effect");
		git(source, ["config", "merge.swarm-probe.driver", `sh -c 'printf escaped > ${JSON.stringify(escaped)}; exit 1'`]);
		const run = { runId: "run_merge", gitRoot: source, config: defaultConfig } as RunRecord;
		const root = makeNode(run.runId, "node_root", "coordinator", "Fixture", source, null);
		const manager = makeNode(run.runId, "node_manager", "manager", "Manage", "", root.nodeId);
		const managerTree = createWorktree(run, root, manager.nodeId, false);
		Object.assign(manager, { cwd: managerTree.path, branch: managerTree.branch, baseCommit: managerTree.baseCommit, status: "running" });
		const child = makeNode(run.runId, "node_worker", "worker", "Implement", "", manager.nodeId);
		const childTree = createWorktree(run, manager, child.nodeId, false);
		Object.assign(child, { cwd: childTree.path, branch: childTree.branch, baseCommit: childTree.baseCommit, status: "completed", review: { action: "accept", updatedAt: Date.now() } });
		writeFileSync(join(child.cwd, "feature"), "child change\n");
		child.result = { text: "Changed", commit: commitResult(child, "Complete fixture worker"), submittedAt: Date.now() };
		writeFileSync(join(manager.cwd, "feature"), "manager change\n");
		writeFileSync(join(manager.cwd, ".gitattributes"), "feature merge=swarm-probe\n");
		const managerCommit = commitResult(manager, "Prepare fixture conflict");
		expect(() => integrateResult(run, manager, child)).toThrow("Custom Git merge drivers are unsupported");
		expect(existsSync(escaped)).toBe(false);
		expect(repositoryInfo(manager.cwd).head).toBe(managerCommit);
		expect(repositoryInfo(manager.cwd).status).toBe("");
		expect(repositoryInfo(child.cwd).head).toBe(child.result.commit!);
		// Command suppression also protects a merge if attributes change after preflight.
		expect(git(manager.cwd, ["merge", "--no-ff", "--no-edit", child.result.commit!], true).ok).toBe(false);
		expect(existsSync(escaped)).toBe(false);
		git(manager.cwd, ["merge", "--abort"]);
		expect(repositoryInfo(manager.cwd).head).toBe(managerCommit);
	} finally {
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(source, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});

macTest("integration preserves Git's built-in union and binary merge behavior", () => {
	const source = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-builtin-merge-source-")));
	const state = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-builtin-merge-state-")));
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = state;
	try {
		git(source, ["init", "-b", "main"]);
		git(source, ["config", "user.name", "Swarm Test"]);
		git(source, ["config", "user.email", "swarm@example.invalid"]);
		writeFileSync(join(source, "union"), "base\n");
		writeFileSync(join(source, "binary"), Buffer.from([0, 1, 2]));
		writeFileSync(join(source, ".gitattributes"), "union merge=union\nbinary merge=binary\n");
		git(source, ["add", "."]); git(source, ["commit", "-m", "Initialize fixture"]);
		const run = { runId: "run_builtins", gitRoot: source, config: defaultConfig } as RunRecord;
		const root = makeNode(run.runId, "node_root", "coordinator", "Fixture", source, null);
		const manager = makeNode(run.runId, "node_manager", "manager", "Manage", "", root.nodeId);
		const managerTree = createWorktree(run, root, manager.nodeId, false);
		Object.assign(manager, { cwd: managerTree.path, branch: managerTree.branch, baseCommit: managerTree.baseCommit, status: "running" });

		const unionChild = makeNode(run.runId, "node_union", "worker", "Union", "", manager.nodeId);
		const unionTree = createWorktree(run, manager, unionChild.nodeId, false);
		Object.assign(unionChild, { cwd: unionTree.path, branch: unionTree.branch, baseCommit: unionTree.baseCommit, status: "completed", review: { action: "accept", updatedAt: Date.now() } });
		writeFileSync(join(unionChild.cwd, "union"), "base\nchild\n");
		unionChild.result = { text: "Child union change", commit: commitResult(unionChild, "Complete union child"), submittedAt: Date.now() };
		writeFileSync(join(manager.cwd, "union"), "base\nmanager\n");
		commitResult(manager, "Prepare union merge");
		integrateResult(run, manager, unionChild);
		const mergedUnion = readFileSync(join(manager.cwd, "union"), "utf8");
		expect(mergedUnion).toContain("child\n");
		expect(mergedUnion).toContain("manager\n");

		const binaryChild = makeNode(run.runId, "node_binary", "worker", "Binary", "", manager.nodeId);
		const binaryTree = createWorktree(run, manager, binaryChild.nodeId, false);
		Object.assign(binaryChild, { cwd: binaryTree.path, branch: binaryTree.branch, baseCommit: binaryTree.baseCommit, status: "completed", review: { action: "accept", updatedAt: Date.now() } });
		writeFileSync(join(binaryChild.cwd, "binary"), Buffer.from([0, 3, 2]));
		binaryChild.result = { text: "Child binary change", commit: commitResult(binaryChild, "Complete binary child"), submittedAt: Date.now() };
		writeFileSync(join(manager.cwd, "binary"), Buffer.from([0, 4, 2]));
		const managerCommit = commitResult(manager, "Prepare binary conflict");
		expect(() => integrateResult(run, manager, binaryChild)).toThrow("Integration conflict");
		expect(repositoryInfo(manager.cwd).head).toBe(managerCommit);
		expect(repositoryInfo(manager.cwd).status).toBe("");
		expect(readFileSync(join(manager.cwd, "binary"))).toEqual(Buffer.from([0, 4, 2]));
	} finally {
		if (previous === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previous;
		rmSync(source, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
}, 15000);
