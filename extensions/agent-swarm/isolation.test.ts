import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { sandboxProfile, workerEnvironment } from "./isolation.ts";

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
	expect(environment.XDG_CACHE_HOME).toBe("/worker/tmp/cache");
	expect(environment.PYTHONPYCACHEPREFIX).toBe("/worker/tmp/python-bytecode");
	expect(environment.UV_CACHE_DIR).toBe("/worker/tmp/uv-cache");
	expect(environment.UV_PROJECT_ENVIRONMENT).toBe("/worker/tmp/uv-venv");

	const overridden = workerEnvironment({ TMPDIR: "/worker/tmp", UV_CACHE_DIR: "/explicit/cache" });
	expect(overridden.UV_CACHE_DIR).toBe("/explicit/cache");
});

const macTest = process.platform === "darwin" ? test : test.skip;
const writePolicy = (root: string) => {
	const coordinatorWorktree = join(root, "coordinator");
	const gitCommonDir = join(root, "git-common");
	const hostHome = join(root, "host-home");
	const sourceAgentDir = join(hostHome, ".pi", "agent");
	for (const path of [coordinatorWorktree, gitCommonDir, sourceAgentDir, join(hostHome, ".ssh")]) mkdirSync(path, { recursive: true });
	return { stateRoot: root, coordinatorWorktree, gitCommonDir, hostHome, sourceAgentDir };
};

macTest("real sandbox permits all reads and denies sibling writes and Git metadata", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-sandbox-")));
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-writable-")));
	const worktree = join(root, "worktree");
	const home = join(root, "home");
	const temporary = join(root, "tmp");
	const outbox = join(root, "outbox");
	const inbox = join(root, "inbox");
	for (const path of [worktree, home, temporary, outbox, inbox]) mkdirSync(path);
	writeFileSync(join(worktree, ".git"), "gitdir: /forbidden\n");
	writeFileSync(join(root, "secret"), "nope\n");
	const policy = writePolicy(root);
	const profile = join(root, "profile.sb");
	writeFileSync(profile, sandboxProfile({ worktree, workerHome: home, workerTmp: temporary, outbox, inbox, ...policy }));
	try {
		expect(() => sandboxProfile({ worktree, workerHome: worktree, workerTmp: temporary, outbox, inbox, ...policy })).toThrow("overlap");
		const allowed = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `printf yes > ${JSON.stringify(join(worktree, "owned"))}`]);
		expect(allowed.status).toBe(0);
		const defaultWrite = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `printf yes > ${JSON.stringify(join(outside, "allowed"))}`]);
		expect(defaultWrite.status).toBe(0);
		const siblingRead = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/cat", join(root, "secret")], { encoding: "utf8" });
		expect(siblingRead.stdout).toBe("nope\n");
		const hardlink = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/ln", join(root, "secret"), join(worktree, "hardlink")]);
		expect(hardlink.status).not.toBe(0);
		const dataAlias = `/System/Volumes/Data${join(root, "secret")}`;
		expect(spawnSync("/bin/cat", [dataAlias]).status).toBe(0);
		expect(spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/cat", dataAlias]).status).toBe(0);
		const gitDenied = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `printf bad > ${JSON.stringify(join(worktree, ".git"))}`]);
		expect(gitDenied.status).not.toBe(0);
		const siblingWrite = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `printf bad > ${JSON.stringify(join(root, "secret"))}`]);
		expect(siblingWrite.status).not.toBe(0);
		const coordinatorWrite = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `printf bad > ${JSON.stringify(join(policy.coordinatorWorktree, "changed"))}`]);
		expect(coordinatorWrite.status).not.toBe(0);
		const credentialWrite = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `printf bad > ${JSON.stringify(join(policy.hostHome, ".ssh", "key"))}`]);
		expect(credentialWrite.status).not.toBe(0);
		writeFileSync(join(policy.hostHome, ".ssh", "key"), "credential\n");
		symlinkSync(join(policy.hostHome, ".ssh", "key"), join(worktree, "credential-link"));
		const credentialAliasWrite = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `printf bad > ${JSON.stringify(join(worktree, "credential-link"))}`]);
		expect(credentialAliasWrite.status).not.toBe(0);
		const futureSibling = join(root, "nodes", "future", "worktree");
		mkdirSync(futureSibling, { recursive: true });
		const futureSiblingWrite = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `printf bad > ${JSON.stringify(join(futureSibling, "changed"))}`]);
		expect(futureSiblingWrite.status).not.toBe(0);
		symlinkSync(join(root, "secret"), join(worktree, "indirect"));
		const indirectRead = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/cat", join(worktree, "indirect")], { encoding: "utf8" });
		expect(indirectRead.stdout).toBe("nope\n");
		const inboxWrite = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `printf bad > ${JSON.stringify(join(inbox, "forged"))}`]);
		expect(inboxWrite.status).not.toBe(0);
		writeFileSync(profile, sandboxProfile({ worktree, workerHome: home, workerTmp: temporary, outbox, inbox, ...policy, readOnlyWorktree: true }));
		const reviewerWrite = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", `printf bad > ${JSON.stringify(join(worktree, "owned"))}`]);
		expect(reviewerWrite.status).not.toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

macTest("sandbox denies a live host Unix socket and sibling process credentials", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-swarm-socket-")));
	const directories = ["worktree", "home", "tmp", "outbox", "inbox"].map((name) => join(root, name));
	for (const path of directories) mkdirSync(path);
	const [worktree, workerHome, workerTmp, outbox, inbox] = directories;
	const socket = join(root, "host.sock");
	const server = createServer((connection) => connection.end());
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
	const node = realpathSync(spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim());
	const profile = join(root, "profile.sb");
	const policy = writePolicy(root);
	const sibling = spawn(node, ["-e", "setTimeout(() => {}, 10000)"], { env: { PI_SWARM_TEST_SECRET: "sibling-credential-sentinel" }, stdio: "ignore" });
	const siblingExited = new Promise<void>((resolve) => sibling.once("close", () => resolve()));
	try {
		const probe = join(root, "procargs");
		const source = join(root, "procargs.c");
		writeFileSync(source, `#include <sys/types.h>\n#include <sys/sysctl.h>\n#include <stdio.h>\n#include <stdlib.h>\nint main(int argc, char **argv) { int mib[] = {CTL_KERN, KERN_PROCARGS2, atoi(argv[1])}; char bytes[1048576]; size_t size = sizeof(bytes); if (sysctl(mib, 3, bytes, &size, NULL, 0)) { perror("sysctl"); return 1; } fwrite(bytes, 1, size, stdout); return 0; }\n`);
		const compiled = spawnSync("/usr/bin/cc", [source, "-o", probe], { encoding: "utf8" });
		if (compiled.status !== 0) throw new Error(compiled.stderr);
		writeFileSync(profile, sandboxProfile({ worktree, workerHome, workerTmp, outbox, inbox, ...policy }));
		const code = `const s = require('node:net').connect(${JSON.stringify(socket)}); s.on('connect', () => process.exit(0)); s.on('error', e => { console.error(e.code); process.exit(1); });`;
		const unrestricted = spawnSync(node, ["-e", code], { encoding: "utf8", timeout: 2000 });
		expect(unrestricted.status).toBe(0);
		const restricted = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, node, "-e", code], { encoding: "utf8", timeout: 2000 });
		expect(restricted.status).toBe(1);
		expect(restricted.stderr).toMatch(/EPERM|EACCES/);
		const unrestrictedProcess = spawnSync("/bin/ps", ["eww", "-p", String(sibling.pid)], { encoding: "utf8" });
		expect(unrestrictedProcess.stdout).toContain("sibling-credential-sentinel");
		const restrictedProcess = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, "/bin/ps", "eww", "-p", String(sibling.pid)], { encoding: "utf8" });
		expect(restrictedProcess.stdout).not.toContain("sibling-credential-sentinel");
		const rawProcess = spawnSync(probe, [String(sibling.pid)], { encoding: "utf8" });
		expect(rawProcess.stdout).toContain("sibling-credential-sentinel");
		const restrictedRawProcess = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, probe, String(sibling.pid)], { encoding: "utf8" });
		expect(restrictedRawProcess.status).toBe(1);
		expect(restrictedRawProcess.stderr).toContain("sysctl: Operation not permitted");
		expect(restrictedRawProcess.stdout).not.toContain("sibling-credential-sentinel");
	} finally {
		sibling.kill("SIGKILL");
		await siblingExited;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});
