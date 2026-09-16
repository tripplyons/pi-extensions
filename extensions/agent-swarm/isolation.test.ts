import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxProfile, workerEnvironment, writeSandboxProfile, type SandboxPaths } from "./isolation.ts";

test("worker environment drops unrelated host credentials", () => {
	const previous = process.env.AWS_SECRET_ACCESS_KEY;
	process.env.AWS_SECRET_ACCESS_KEY = "sentinel";
	try {
		const environment = workerEnvironment({ HOME: "/worker/home", PI_SWARM_TOKEN: "owned" });
		expect(environment.HOME).toBe("/worker/home");
		expect(environment.PI_SWARM_TOKEN).toBe("owned");
		expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
	} finally {
		if (previous === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
		else process.env.AWS_SECRET_ACCESS_KEY = previous;
	}
});

test("worker caches, Python bytecode, and uv environments default under worker tmp", () => {
	const environment = workerEnvironment({ TMPDIR: "/worker/tmp" });
	expect(environment.PI_BG_BASH_TMUX_SOCKET).toBe("/worker/tmp/bg.sock");
	expect(environment.XDG_CACHE_HOME).toBe("/worker/tmp/cache");
	expect(environment.PYTHONPYCACHEPREFIX).toBe("/worker/tmp/python-bytecode");
	expect(environment.UV_CACHE_DIR).toBe("/worker/tmp/uv-cache");
	expect(environment.UV_PROJECT_ENVIRONMENT).toBe("/worker/tmp/uv-venv");

	const overridden = workerEnvironment({ TMPDIR: "/worker/tmp", UV_CACHE_DIR: "/explicit/cache" });
	expect(overridden.UV_CACHE_DIR).toBe("/explicit/cache");
});

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-profile-")));
	const named = (name: string) => {
		const path = join(root, name);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const hostHome = named("host-home");
	const paths: SandboxPaths = {
		worktree: named("worktree"),
		workerHome: named("home"),
		workerTmp: named("tmp"),
		outbox: named("outbox"),
		inbox: named("inbox"),
		stateRoot: root,
		coordinatorWorktree: named("coordinator"),
		gitCommonDir: named("git-common"),
		hostHome,
		sourceAgentDir: named("host-home/.pi/agent"),
	};
	mkdirSync(join(hostHome, ".ssh"), { recursive: true });
	return { root, paths };
}

const subpathRule = (path: string) => `(subpath "${path}")`;
const literalRule = (path: string) => `(literal "${path}")`;

test("sandbox profile expresses the protected-write and private-runtime boundaries", () => {
	const { root, paths } = fixture();
	try {
		const profile = sandboxProfile(paths);
		expect(profile).toContain("(deny default)");
		expect(profile).toContain("(allow file-read*)");
		expect(profile).toContain("(allow file-write*)");
		expect(profile).toContain("(deny process-info* nvram*)");
		expect(profile).toContain("(allow process-info* (target self))");
		expect(profile).toContain(`(allow network-bind network-inbound network-outbound ${literalRule(join(paths.workerTmp, "bg.sock"))})`);
		expect(profile).toContain(subpathRule(paths.stateRoot));
		for (const writable of [paths.workerHome, paths.workerTmp, paths.outbox, paths.worktree]) {
			expect(profile).toContain(`(require-not ${subpathRule(writable)})`);
		}
		for (const protectedPath of [paths.coordinatorWorktree, paths.gitCommonDir, join(paths.hostHome, ".ssh"), join(paths.sourceAgentDir, "auth.json")]) {
			expect(profile).toContain(`(deny file-write* ${subpathRule(protectedPath)})`);
		}
		expect(profile).toContain(`(deny file-write* ${literalRule(join(paths.worktree, ".git"))})`);
		for (const privateRoot of [paths.worktree, paths.workerHome, paths.workerTmp, paths.outbox, paths.inbox]) {
			expect(profile).toContain(`(deny file-write-unlink ${literalRule(privateRoot)})`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reviewer profiles make the worktree read-only and reject overlapping private roots", () => {
	const { root, paths } = fixture();
	try {
		const profile = sandboxProfile({ ...paths, readOnlyWorktree: true });
		const stateRule = profile.split("\n").find(line => line.startsWith("(deny file-write* (require-all"))!;
		expect(stateRule).not.toContain(`(require-not ${subpathRule(paths.worktree)})`);
		expect(() => sandboxProfile({ ...paths, workerHome: paths.worktree })).toThrow("overlap");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sandbox profile files are created with owner-only permissions", () => {
	const { root, paths } = fixture();
	try {
		const destination = join(root, "worker.sb");
		expect(writeSandboxProfile(destination, paths)).toBe(destination);
		expect(statSync(destination).mode & 0o777).toBe(0o600);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
