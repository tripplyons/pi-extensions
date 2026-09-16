import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertSupportedAttributes,
	createGitRunner,
	createWorktree,
	generatedBranch,
	integrateResult,
	repositoryInfo,
	setGitRunnerForTests,
} from "./git.ts";
import type { NodeRecord, RunRecord } from "./types.ts";

afterEach(() => setGitRunnerForTests());

const result = (stdout = "", status = 0, stderr = "") => ({ status, stdout, stderr });

test("Git runner hardens effectful commands and suppresses configured filters and merge drivers", () => {
	const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; input?: string }> = [];
	const execute = (_command: string, args: string[], options: { env: NodeJS.ProcessEnv; input?: string }) => {
		calls.push({ args, env: options.env, input: options.input });
		const command = args.slice(args.indexOf("-C") + 2);
		if (command.includes("config") && command.at(-1)?.startsWith("^filter")) return result("filter.secret.clean\nfilter.secret.required\n");
		if (command.includes("config") && command.at(-1)?.startsWith("^merge")) return result("merge.host.driver\0");
		if (command.includes("ls-files")) return result("tracked\0");
		if (command.includes("ls-tree")) return result("tracked\0");
		if (command.includes("check-attr")) return result("tracked\0filter\0unspecified\0");
		return result();
	};
	const previous = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = "/host/config";
	try {
		createGitRunner(execute as any)("/repo", ["add", "-A"]);
	} finally {
		if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = previous;
	}

	const final = calls.at(-1)!;
	expect(final.args).toContain("filter.secret.clean=");
	expect(final.args).toContain("filter.secret.required=false");
	expect(final.args).toContain("merge.host.driver=/usr/bin/false");
	expect(final.args).toContain("core.hooksPath=/dev/null");
	expect(final.env.GIT_CONFIG_GLOBAL).toBeUndefined();
	expect(final.env.GIT_TERMINAL_PROMPT).toBe("0");
	expect(final.env.GIT_OPTIONAL_LOCKS).toBe("0");
});

test("Git runner disables diff helpers and rejects selected content filters", () => {
	const commands: string[][] = [];
	const execute = (_command: string, args: string[]) => {
		const command = args.slice(args.indexOf("-C") + 2);
		commands.push(command);
		if (command[0] === "config") return result("", 1);
		if (command[0] === "ls-files" || command[0] === "ls-tree") return result("unsafe\0");
		if (command[0] === "check-attr") return result("unsafe\0filter\0credential-helper\0");
		return result();
	};
	const run = createGitRunner(execute as any);
	run("/repo", ["diff", "HEAD"]);
	expect(commands.at(-1)).toEqual(["diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
	expect(() => run("/repo", ["add", "-A"])).toThrow("Git content filters are unsupported: unsafe");
});

test("repository metadata is parsed from batched path and porcelain queries", () => {
	const calls: string[][] = [];
	setGitRunnerForTests(((cwd: string, args: string[]) => {
		calls.push(args);
		if (args[0] === "rev-parse") return { ok: true, stdout: `${cwd}\n${cwd}/.git\n`, stderr: "" };
		if (args[0] === "status") return { ok: true, stdout: "# branch.oid abc123\n# branch.head main\n? untracked\n", stderr: "" };
		throw new Error(`Unexpected Git command: ${args.join(" ")}`);
	}) as any);
	expect(repositoryInfo("/repo")).toEqual({ root: "/repo", commonDir: "/repo/.git", branch: "main", head: "abc123", status: "? untracked\n" });
	expect(calls).toHaveLength(2);
});

test("dirty snapshot planning refuses implicit transfer and copies untracked files without Git", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-git-unit-")));
	const state = join(root, "state");
	const source = join(root, "source");
	mkdirSync(source);
	writeFileSync(join(source, "untracked"), "preserved\n");
	const previous = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = state;
	setGitRunnerForTests(((cwd: string, args: string[]) => {
		if (args[0] === "rev-parse") return { ok: true, stdout: `${source}\n${source}/.git\n`, stderr: "" };
		if (args[0] === "status") return { ok: true, stdout: "# branch.oid aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n# branch.head main\n? untracked\n", stderr: "" };
		if (args[0] === "ls-tree") return { ok: true, stdout: "", stderr: "" };
		if (args[0] === "check-attr") return { ok: true, stdout: "", stderr: "" };
		if (args[0] === "worktree") { mkdirSync(args[4], { recursive: true }); return { ok: true, stdout: "", stderr: "" }; }
		if (args[0] === "diff") return { ok: true, stdout: "", stderr: "" };
		if (args[0] === "ls-files") return { ok: true, stdout: "untracked\0", stderr: "" };
		throw new Error(`Unexpected Git command in ${cwd}: ${args.join(" ")}`);
	}) as any);
	try {
		const run = { runId: "run_snapshot", gitRoot: source } as RunRecord;
		const parent = { cwd: source } as NodeRecord;
		expect(() => createWorktree(run, parent, "node_refused", false)).toThrow("dirty");
		const child = createWorktree(run, parent, "node_child", true);
		expect(Bun.file(join(child.path, "untracked")).text()).resolves.toBe("preserved\n");
		expect(child.branch).toBe(generatedBranch(run.runId, "node_child"));
	} finally {
		if (previous === undefined) delete process.env.PI_SWARM_HOME;
		else process.env.PI_SWARM_HOME = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("integration validates authority, cleanliness, ancestry, merge attributes, and rollback", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-integrate-unit-")));
	const managerPath = join(root, "manager");
	const childPath = join(root, "child");
	mkdirSync(managerPath); mkdirSync(childPath);
	const heads = new Map([[managerPath, "manager-head"], [childPath, "child-head"]]);
	const dirty = new Set<string>();
	let mergeAttribute = "unspecified";
	let mergeSucceeds = false;
	const commands: string[][] = [];
	setGitRunnerForTests(((cwd: string, args: string[], allowFailure = false) => {
		commands.push(args);
		if (args[0] === "rev-parse" && args.includes("--git-path")) return { ok: true, stdout: args.filter(value => !value.startsWith("-") && !["rev-parse"].includes(value)).map(value => join(cwd, value)).join("\n") + "\n", stderr: "" };
		if (args[0] === "rev-parse") return { ok: true, stdout: `${cwd}\n${cwd}/.git\n`, stderr: "" };
		if (args[0] === "status") return { ok: true, stdout: `# branch.oid ${heads.get(cwd)}\n# branch.head ${cwd === managerPath ? "main" : generatedBranch("run_test", "node_child")}\n${dirty.has(cwd) ? "? dirty\n" : ""}`, stderr: "" };
		if (args[0] === "ls-tree" || args[0] === "ls-files") return { ok: true, stdout: "feature\0", stderr: "" };
		if (args[0] === "check-attr") return { ok: true, stdout: `feature\0${args.at(-1)}\0${args.at(-1) === "merge" ? mergeAttribute : "unspecified"}\0`, stderr: "" };
		if (args[0] === "merge-base") return { ok: true, stdout: "", stderr: "" };
		if (args[0] === "merge" && args[1] === "--abort") return { ok: true, stdout: "", stderr: "" };
		if (args[0] === "merge") {
			if (!mergeSucceeds) return { ok: false, stdout: "", stderr: "conflict" };
			heads.set(cwd, "merged-head");
			return { ok: true, stdout: "", stderr: "" };
		}
		throw new Error(`Unexpected Git command: ${args.join(" ")} (allowFailure=${allowFailure})`);
	}) as any);

	const run = { runId: "run_test", rootNodeId: "node_root", gitRoot: managerPath, config: { protectedBranches: ["main"] } } as RunRecord;
	const manager = { runId: run.runId, nodeId: "node_root", parentId: null, role: "coordinator", cwd: managerPath, branch: "main" } as NodeRecord;
	const child = {
		runId: run.runId, nodeId: "node_child", parentId: manager.nodeId, role: "worker", cwd: childPath,
		branch: generatedBranch(run.runId, "node_child"), baseCommit: "base", status: "completed",
		review: { action: "accept" }, result: { text: "done", commit: "child-head", submittedAt: 1 },
	} as NodeRecord;
	try {
		expect(() => integrateResult(run, { ...manager, nodeId: "impostor" }, child)).toThrow("root coordinator checkout");
		dirty.add(managerPath);
		expect(() => integrateResult(run, manager, child)).toThrow(`Worktree is dirty: ${manager.nodeId}`);
		dirty.clear();
		mergeAttribute = "host-driver";
		expect(() => integrateResult(run, manager, child)).toThrow("Custom Git merge drivers are unsupported");
		expect(commands.some(command => command[0] === "merge")).toBe(false);
		mergeAttribute = "union";
		expect(() => integrateResult(run, manager, child)).toThrow("Integration conflict: conflict");
		expect(commands.some(command => command[0] === "merge" && command[1] === "--abort")).toBe(true);
		expect(heads.get(managerPath)).toBe("manager-head");
		mergeSucceeds = true;
		expect(integrateResult(run, manager, child)).toBe("merged-head");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("attribute validation permits built-in merge modes and rejects executable drivers", () => {
	for (const value of ["unspecified", "set", "unset", "text", "binary", "union"]) {
		expect(() => assertSupportedAttributes(["feature", "merge", value], "merge")).not.toThrow();
	}
	expect(() => assertSupportedAttributes(["feature", "merge", "host-driver"], "merge")).toThrow("feature uses host-driver");
	expect(() => assertSupportedAttributes(["secret", "filter", "credential-helper"], "filter")).toThrow("secret");
});
