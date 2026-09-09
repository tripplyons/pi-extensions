import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export interface SandboxPaths {
	worktree: string;
	workerHome: string;
	workerTmp: string;
	outbox: string;
	inbox: string;
	readableRuntime: string[];
	readOnlyWorktree?: boolean;
}

const canonicalExisting = (path: string) => realpathSync(resolve(path));
const canonicalDestination = (path: string) => join(realpathSync(dirname(resolve(path))), resolve(path).split(sep).at(-1)!);
const quoteScheme = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export const assertMacSandboxAvailable = () => {
	if (process.platform !== "darwin") throw new Error("agent-swarm requires macOS sandbox-exec");
	const result = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`sandbox-exec probe failed: ${result.stderr.trim() || `exit ${result.status}`}`);
};

export const sandboxProfile = (paths: SandboxPaths) => {
	const worktree = canonicalExisting(paths.worktree);
	const home = canonicalExisting(paths.workerHome);
	const temporary = canonicalExisting(paths.workerTmp);
	const outbox = canonicalExisting(paths.outbox);
	const inbox = canonicalExisting(paths.inbox);
	const runtime = paths.readableRuntime.map(canonicalExisting);
	const privateRoots = [worktree, home, temporary, outbox, inbox];
	for (let index = 0; index < privateRoots.length; index++) {
		const path = privateRoots[index];
		if (path === "/") throw new Error("Sandbox private paths cannot be the filesystem root");
		for (const other of privateRoots.slice(index + 1)) {
			if (path === other || path.startsWith(other + sep) || other.startsWith(path + sep)) throw new Error("Sandbox private paths must not overlap");
		}
	}
	if (runtime.includes("/")) throw new Error("Sandbox runtime cannot expose the filesystem root");
	const readable = ["/System", "/usr", "/bin", "/sbin", "/private/etc", worktree, home, temporary, outbox, inbox, ...runtime];
	return [
		"(version 1)",
		"(deny default)",
		"(deny process-info* nvram*)",
		"(allow process-info* (target self))",
		"(allow process-exec process-fork)",
		'(allow sysctl-read (sysctl-name-prefix "hw."))',
		...["kern.ostype", "kern.osrelease", "kern.osversion", "kern.osproductversion", "kern.version", "kern.hostname", "kern.argmax", "kern.boottime", "kern.maxfilesperproc", "machdep.cpu.brand_string"].map((name) => `(allow sysctl-read (sysctl-name ${quoteScheme(name)}))`),
		"(allow mach-lookup)",
		"(allow network-outbound (remote tcp) (remote udp))",
		'(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
		"(allow file-read-metadata)",
		'(allow file-read-data (literal "/"))',
		'(allow file-read* (literal "/private/var/select/sh"))',
		...["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"].map((path) => `(allow file-read* (literal ${quoteScheme(path)}))`),
		...readable.map((path) => `(allow file-read* (subpath ${quoteScheme(path)}))`),
		...(paths.readOnlyWorktree ? [] : [`(allow file-write* (subpath ${quoteScheme(worktree)}))`]),
		`(deny file-write* (literal ${quoteScheme(join(worktree, ".git"))}))`,
		`(allow file-write* (subpath ${quoteScheme(home)}))`,
		`(allow file-write* (subpath ${quoteScheme(temporary)}))`,
		`(allow file-write* (subpath ${quoteScheme(outbox)}))`,
		`(allow file-write* (literal ${quoteScheme("/dev/null")}))`,
		...privateRoots.map((path) => `(deny file-write-unlink (literal ${quoteScheme(path)}))`),
	].join("\n") + "\n";
};

export const writeSandboxProfile = (path: string, paths: SandboxPaths) => {
	writeFileSync(canonicalDestination(path), sandboxProfile(paths), { mode: 0o600 });
	return path;
};

const inheritedEnvironment = ["PATH", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];

export const workerEnvironment = (values: Record<string, string>) => {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of inheritedEnvironment) if (process.env[name]) environment[name] = process.env[name];
	for (const [name, value] of Object.entries(values)) environment[name] = value;
	return environment;
};
