import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export interface SandboxPaths {
	worktree: string;
	workerHome: string;
	workerTmp: string;
	outbox: string;
	inbox: string;
	stateRoot: string;
	coordinatorWorktree: string;
	gitCommonDir: string;
	hostHome: string;
	sourceAgentDir: string;
	readOnlyWorktree?: boolean;
}

const canonicalExisting = (path: string) => realpathSync(resolve(path));
const canonicalDestination = (path: string) => join(realpathSync(dirname(resolve(path))), resolve(path).split(sep).at(-1)!);
const canonicalDeniedPath = (path: string) => {
	let existing = resolve(path);
	const suffix: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) throw new Error(`Cannot resolve denied path: ${path}`);
		suffix.unshift(existing.split(sep).at(-1)!);
		existing = parent;
	}
	return join(realpathSync(existing), ...suffix);
};
const quoteScheme = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const systemWriteDenials = ["/System", "/usr", "/bin", "/sbin", "/Library", "/Applications", "/private/etc"];
const credentialWriteDenials = (home: string, sourceAgentDir: string) => [
	join(home, ".ssh"), join(home, ".aws"), join(home, ".azure"), join(home, ".docker"), join(home, ".kube"),
	join(home, ".config", "gcloud"), join(home, ".config", "gh"), join(home, "Library", "Keychains"),
	join(home, ".netrc"), join(home, ".git-credentials"), join(home, ".npmrc"), join(home, ".pypirc"),
	join(sourceAgentDir, "auth.json"),
];

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
	const state = canonicalExisting(paths.stateRoot);
	const privateRoots = [worktree, home, temporary, outbox, inbox];
	for (let index = 0; index < privateRoots.length; index++) {
		const path = privateRoots[index];
		if (path === "/") throw new Error("Sandbox private paths cannot be the filesystem root");
		for (const other of privateRoots.slice(index + 1)) {
			if (path === other || path.startsWith(other + sep) || other.startsWith(path + sep)) throw new Error("Sandbox private paths must not overlap");
		}
	}
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
		`(allow network-bind network-inbound network-outbound (literal ${quoteScheme(join(temporary, "bg.sock"))}))`,
		'(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
		"(allow file-read*)",
		"(allow file-write*)",
		`(deny file-write* (require-all (subpath ${quoteScheme(state)}) ${[
			home, temporary, outbox, ...(!paths.readOnlyWorktree ? [worktree] : []),
		].map((path) => `(require-not (subpath ${quoteScheme(path)}))`).join(" ")}))`,
		...[paths.coordinatorWorktree, paths.gitCommonDir, ...systemWriteDenials, ...credentialWriteDenials(paths.hostHome, paths.sourceAgentDir)]
			.map(canonicalDeniedPath)
			.map((path) => `(deny file-write* (subpath ${quoteScheme(path)}))`),
		'(allow pseudo-tty)',
		'(allow file-ioctl (literal "/dev/ptmx") (regex #"^/dev/[pt]tys[0-9]+$"))',
		'(deny file-write* (require-all (subpath "/dev") (require-not (literal "/dev/null")) (require-not (literal "/dev/ptmx")) (require-not (regex #"^/dev/[pt]tys[0-9]+$"))))',
		`(deny file-write* (literal ${quoteScheme(join(worktree, ".git"))}))`,
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
	// Tooling commonly defaults these paths to the current project. That fails for
	// reviewers, whose source snapshot is intentionally read-only.
	if (values.TMPDIR) {
		environment.PI_BG_BASH_TMUX_SOCKET = join(values.TMPDIR, "bg.sock");
		environment.XDG_CACHE_HOME ??= join(values.TMPDIR, "cache");
		environment.PYTHONPYCACHEPREFIX ??= join(values.TMPDIR, "python-bytecode");
		environment.UV_CACHE_DIR ??= join(values.TMPDIR, "uv-cache");
		environment.UV_PROJECT_ENVIRONMENT ??= join(values.TMPDIR, "uv-venv");
	}
	return environment;
};
