import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { commitResult, createWorktree, git, repositoryInfo } from "./git.ts";
import { sandboxProfile } from "./isolation.ts";
import { type NodeRecord, type RunRecord } from "./types.ts";

const macTest = process.platform === "darwin" ? test : test.skip;

macTest("dirty snapshots preserve the parent and workers cannot stage into shared Git metadata", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-git-")));
	const previousHome = process.env.PI_SWARM_HOME;
	process.env.PI_SWARM_HOME = join(root, "state");
	const source = join(root, "source");
	mkdirSync(source);
	try {
		git(source, ["init", "-b", "main"]);
		git(source, ["config", "user.name", "Swarm Test"]);
		git(source, ["config", "user.email", "swarm@example.invalid"]);
		writeFileSync(join(source, "tracked"), "base\n");
		git(source, ["add", "tracked"]);
		git(source, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "Initialize fixture"]);
		writeFileSync(join(source, "tracked"), "staged\n");
		git(source, ["add", "tracked"]);
		writeFileSync(join(source, "tracked"), "unstaged\n");
		writeFileSync(join(source, "untracked"), "untracked\n");
		const before = repositoryInfo(source);
		const index = readFileSync(join(before.commonDir, "index"));
		const run = { runId: "run_test", gitRoot: source } as RunRecord;
		const parent = { cwd: source } as NodeRecord;
		expect(() => createWorktree(run, parent, "node_refused", false)).toThrow("dirty");
		const child = createWorktree(run, parent, "node_child", true);
		expect(readFileSync(join(child.path, "tracked"), "utf8")).toBe("unstaged\n");
		expect(readFileSync(join(child.path, "untracked"), "utf8")).toBe("untracked\n");
		expect(readFileSync(join(before.commonDir, "index"))).toEqual(index);
		expect(repositoryInfo(source)).toEqual(before);
		const [workerHome, workerTmp, outbox, inbox] = ["home", "tmp", "outbox", "inbox"].map((name) => join(root, name));
		for (const path of [workerHome, workerTmp, outbox, inbox]) mkdirSync(path);
		const profile = join(root, "worker.sb");
		const executable = realpathSync(spawnSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8" }).stdout.trim());
		writeFileSync(profile, sandboxProfile({
			worktree: child.path, workerHome, workerTmp, outbox, inbox,
			stateRoot: process.env.PI_SWARM_HOME, coordinatorWorktree: source, gitCommonDir: before.commonDir,
			hostHome: join(root, "host-home"), sourceAgentDir: join(root, "host-home", ".pi", "agent"),
		}));
		const denied = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, executable, "-C", child.path, "add", "-A"], { encoding: "utf8", env: { HOME: workerHome, PATH: "/usr/bin:/bin" } });
		expect(denied.status).not.toBe(0);
		expect(denied.stderr).toMatch(/Operation not permitted|Permission denied/);
		const worker = { cwd: child.path, role: "worker", branch: child.branch, runId: run.runId, nodeId: "node_child" } as NodeRecord;
		expect(() => commitResult({ ...worker, cwd: source }, "Refuse source commit")).toThrow("generated branch");
		const commit = commitResult(worker, "Record worker result");
		expect(commit).not.toBe(before.head);
		expect(repositoryInfo(child.path).status).toBe("");
		expect(repositoryInfo(source)).toEqual(before);
		expect(readFileSync(join(before.commonDir, "index"))).toEqual(index);
		// A worker can select a host-configured filter without modifying Git metadata.
		const escaped = join(root, "filter-side-effect");
		git(source, ["config", "filter.swarm-probe.clean", `sh -c 'printf escaped > ${JSON.stringify(escaped)}; cat'`]);
		writeFileSync(join(child.path, ".gitattributes"), "filtered filter=swarm-probe\n");
		writeFileSync(join(child.path, "filtered"), "worker content\n");
		expect(() => commitResult(worker, "Refuse host filter boundary")).toThrow("content filters are unsupported");
		expect(existsSync(escaped)).toBe(false);
		expect(git(child.path, ["rev-parse", "HEAD"]).stdout.trim()).toBe(commit);
		expect(readFileSync(join(before.commonDir, "index"))).toEqual(index);
		writeFileSync(join(source, "root-only-credential"), "host-sentinel\n");
		const redirect = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `mv ${JSON.stringify(child.path)} ${JSON.stringify(join(workerHome, "moved"))} && ln -s ${JSON.stringify(source)} ${JSON.stringify(child.path)}`], { encoding: "utf8" });
		expect(redirect.status).not.toBe(0);
		// Also reject a replaced path before any controller Git command runs.
		rmSync(child.path, { recursive: true });
		symlinkSync(source, child.path);
		expect(() => createWorktree(run, { ...worker, role: "manager" }, "node_redirected", true)).toThrow("path");
	} finally {
		if (previousHome === undefined) delete process.env.PI_SWARM_HOME; else process.env.PI_SWARM_HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
});
