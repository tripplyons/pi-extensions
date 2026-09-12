import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withStatusCard } from "../tool-status-style/style.ts";
import { ASYNC_JOB_COMPLETED_EVENT, isAsyncJobCompletedEvent, type AsyncJobCompletedEvent } from "../subagent/events.ts";

const DEFAULT_GRACE_SECONDS = 5;
const MAX_BASH_TIMEOUT_SECONDS = 300;
const DEFAULT_TAIL_LINES = 120;
const MAX_TAIL_LINES = 2_000;
const MAX_OUTPUT_CHARS = 24_000;
const TAIL_READ_CHUNK_BYTES = 16_384;
const MAX_TAIL_READ_BYTES = MAX_OUTPUT_CHARS * 4;
const MAX_SLEEP_SECONDS = 300;
const TMUX_HISTORY_LINES = 50_000;
const TMUX_JOB_ROOT = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi", "bg-bash");
const AGENT_SWARM_ACTIVITY_EVENT = "tripp:agent-swarm-activity";

type JobStatus = "running" | "exited" | "killed";
type JobBackend = "tmux";
type JobScope = "current" | "all";

interface PublicBackgroundJob {
	id: string;
	pid: number;
	command: string;
	cwd: string;
	backend: JobBackend;
	tmuxSession: string;
	status: JobStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	startedAt: number;
	endedAt: number | null;
	ownerSessionId?: string;
	combinedFile: string;
	stdinClosed: boolean;
}

interface TmuxJob extends PublicBackgroundJob {
	backend: "tmux";
	tmuxSession: string;
	jobDir: string;
	metadataFile: string;
	statusFile: string;
	scriptFile: string;
}

interface ProcessDetails {
	action: "list" | "output" | "kill" | "write" | "clear";
	scope: JobScope;
	jobs: PublicBackgroundJob[];
	message: string;
}

interface JobExitWait {
	promise: Promise<TmuxJob>;
	cancel: () => void;
}

interface AsyncCompletionWait {
	promise: Promise<AsyncJobCompletedEvent>;
	cancel: () => void;
}

type ExternalWake =
	| { type: "steering" }
	| { type: "swarm"; event: unknown };

interface ExternalWakeWait {
	promise: Promise<ExternalWake>;
	cancel: () => void;
}

const BashParams = Type.Object({
	command: Type.String({ description: "Zsh command to execute" }),
	timeout: Type.Optional(Type.Number({
		description: `Foreground grace period in seconds before backgrounding into a persistent tmux job (default ${DEFAULT_GRACE_SECONDS}s, max ${MAX_BASH_TIMEOUT_SECONDS}s)`,
		minimum: 0.1,
		maximum: MAX_BASH_TIMEOUT_SECONDS,
	})),
});

const BgProcessParams = Type.Object({
	action: StringEnum(["list", "output", "kill", "write", "clear"] as const),
	scope: Type.Optional(StringEnum(["current", "all"] as const, {
		description: "Job ownership scope. Defaults to the current Pi session; use all explicitly for foreign or legacy jobs",
	})),
	id: Type.Optional(Type.String({ description: "Background job id" })),
	input: Type.Optional(Type.String({ description: "Input to write to job stdin" })),
	end: Type.Optional(Type.Boolean({ description: "Close stdin after writing" })),
	lines: Type.Optional(Type.Number({
		description: `Tail line count for output (default ${DEFAULT_TAIL_LINES}, max ${MAX_TAIL_LINES})`,
		minimum: 1,
		maximum: MAX_TAIL_LINES,
		multipleOf: 1,
	})),
});

const SleepParams = Type.Object({
	seconds: Type.Number({
		description: `Seconds to sleep for, up to ${MAX_SLEEP_SECONDS} seconds`,
		minimum: 0,
		maximum: MAX_SLEEP_SECONDS,
	}),
});

const shellPath = () => {
	if (existsSync("/bin/zsh")) return "/bin/zsh";
	if (process.env.SHELL && existsSync(process.env.SHELL)) return process.env.SHELL;
	if (existsSync("/bin/bash")) return "/bin/bash";
	return "/bin/sh";
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const tmuxArgs = (args: string[]) => process.env.PI_BG_BASH_TMUX_SOCKET
	? ["-S", basename(process.env.PI_BG_BASH_TMUX_SOCKET), ...args]
	: args;
const tmuxCwd = () => process.env.PI_BG_BASH_TMUX_SOCKET
	? dirname(process.env.PI_BG_BASH_TMUX_SOCKET)
	: undefined;

const runTmux = (args: string[], input?: string) => {
	const result = spawnSync("tmux", tmuxArgs(args), {
		cwd: tmuxCwd(),
		encoding: "utf8",
		...(input === undefined ? {} : { input }),
	});
	if (result.error) throw new Error(`Unable to run tmux: ${result.error.message}`);
	if (result.status !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `tmux exited with code ${result.status}`;
		throw new Error(message);
	}
	return result.stdout.trimEnd();
};

const tmuxSessionExists = (session: string) => {
	const result = spawnSync("tmux", tmuxArgs(["has-session", "-t", session]), { cwd: tmuxCwd(), stdio: "ignore" });
	return result.status === 0;
};

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted) {
		reject(new Error("Sleep aborted"));
		return;
	}

	const timeout = setTimeout(done, ms);

	function done() {
		if (signal) signal.removeEventListener("abort", abort);
		resolve();
	}

	function abort() {
		clearTimeout(timeout);
		reject(new Error("Sleep aborted"));
	}

	if (signal) signal.addEventListener("abort", abort, { once: true });
});

const TERMINAL_ESCAPE_SEQUENCE = /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~]|[ -/]*[0-~])|\x9b[0-?]*[ -/]*[@-~]/g;

const sanitizePtyOutput = (text: string) => text
	.replace(TERMINAL_ESCAPE_SEQUENCE, "")
	.replace(/\r\n?/g, "\n")
	.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");

const isMissingPathError = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const isMissingTmuxSessionError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	return /(?:can't find session|no server running|session not found|target .* not found)/i.test(message);
};

const publicJob = (job: TmuxJob): PublicBackgroundJob => ({
	id: job.id,
	pid: job.pid,
	command: job.command,
	cwd: job.cwd,
	backend: job.backend,
	tmuxSession: job.tmuxSession,
	status: job.status,
	exitCode: job.exitCode,
	signal: job.signal,
	startedAt: job.startedAt,
	endedAt: job.endedAt,
	...(job.ownerSessionId === undefined ? {} : { ownerSessionId: job.ownerSessionId }),
	combinedFile: job.combinedFile,
	stdinClosed: job.stdinClosed,
});

const parseTmuxMetadata = (metadataFile: string, scope: JobScope, currentSessionId: string): TmuxJob | undefined => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(metadataFile, "utf8"));
	} catch (error) {
		if (scope === "current") return undefined;
		throw error;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		if (scope === "current") return undefined;
		throw new Error(`Invalid persistent tmux job metadata: ${metadataFile}`);
	}

	const value = parsed as Record<string, unknown>;
	const ownerSessionId = value.ownerSessionId;
	if (scope === "current" && ownerSessionId !== currentSessionId) return undefined;
	const { id, command, cwd, tmuxSession, pid, startedAt, stdinClosed } = value;
	if (
		(ownerSessionId !== undefined && (typeof ownerSessionId !== "string" || ownerSessionId.length === 0))
		|| typeof id !== "string"
		|| typeof command !== "string"
		|| typeof cwd !== "string"
		|| typeof tmuxSession !== "string"
		|| typeof pid !== "number"
		|| !Number.isFinite(pid)
		|| typeof startedAt !== "number"
		|| !Number.isFinite(startedAt)
		|| (stdinClosed !== undefined && typeof stdinClosed !== "boolean")
	) {
		throw new Error(`Invalid persistent tmux job metadata: ${metadataFile}`);
	}
	const jobDir = dirname(metadataFile);
	const directoryId = basename(jobDir);
	if (id !== directoryId || tmuxSession !== `pi-bg-${directoryId}`) {
		throw new Error(`Mismatched persistent tmux job metadata: ${metadataFile}`);
	}

	return {
		id,
		pid,
		command,
		cwd,
		backend: "tmux",
		tmuxSession,
		status: "running",
		exitCode: null,
		signal: null,
		startedAt,
		endedAt: null,
		...(ownerSessionId === undefined ? {} : { ownerSessionId }),
		combinedFile: join(jobDir, "combined.log"),
		stdinClosed: stdinClosed ?? false,
		jobDir,
		metadataFile,
		statusFile: join(jobDir, "status"),
		scriptFile: join(jobDir, "run.sh"),
	};
};

const truncateOutput = (text: string) => {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `[truncated to last ${MAX_OUTPUT_CHARS} chars]\n${text.slice(-MAX_OUTPUT_CHARS)}`;
};

const tailFile = (path: string, lines: number) => {
	const file = openSync(path, "r");
	try {
		let position = fstatSync(file).size;
		let bytesRead = 0;
		let newlines = 0;
		const chunks: Buffer[] = [];

		while (position > 0 && bytesRead < MAX_TAIL_READ_BYTES && newlines <= lines) {
			const length = Math.min(TAIL_READ_CHUNK_BYTES, position, MAX_TAIL_READ_BYTES - bytesRead);
			position -= length;
			const chunk = Buffer.allocUnsafe(length);
			const count = readSync(file, chunk, 0, length, position);
			if (count === 0) break;
			const content = count === length ? chunk : chunk.subarray(0, count);
			chunks.unshift(content);
			bytesRead += count;
			for (const byte of content) if (byte === 0x0a) newlines++;
		}

		const all = sanitizePtyOutput(Buffer.concat(chunks, bytesRead).toString("utf8")).split("\n");
		if (all[all.length - 1] === "") all.pop();
		return truncateOutput(all.slice(-lines).join("\n"));
	} finally {
		closeSync(file);
	}
};

class BackgroundBashManager {
	private jobs = new Map<string, TmuxJob>();
	private jobExitWaiters = new Set<(job: TmuxJob) => void>();
	private exitWatcher: ReturnType<typeof setInterval> | undefined;
	private watchIds = new Set<string>();
	private currentSessionId: string | undefined;

	constructor() {
		mkdirSync(TMUX_JOB_ROOT, { recursive: true });
	}

	bindSession(sessionId: string) {
		if (!sessionId) throw new Error("Pi session id is unavailable");
		this.currentSessionId = sessionId;
		this.watchIds.clear();
	}

	async run(command: string, cwd: string, foregroundSeconds: number, signal?: AbortSignal) {
		const job = this.spawnTmux(command, cwd);
		let aborted = false;

		const completion = (() => {
			let poll: ReturnType<typeof setInterval> | undefined;
			const promise = new Promise<TmuxJob>((resolve) => {
				poll = setInterval(() => {
					if (!existsSync(job.statusFile)) return;
					if (poll) clearInterval(poll);
					resolve(job);
				}, 25);
			});
			return {
				promise,
				cancel: () => {
					if (poll) clearInterval(poll);
				},
			};
		})();

		const abort = () => {
			aborted = true;
			if (tmuxSessionExists(job.tmuxSession)) runTmux(["kill-session", "-t", job.tmuxSession]);
		};

		if (signal) {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}

		const completed = await Promise.race([
			completion.promise,
			delay(Math.max(0.1, foregroundSeconds) * 1000).then(() => false),
		]);
		if (!completed) completion.cancel();
		if (signal) signal.removeEventListener("abort", abort);

		if (aborted) {
			try {
				this.refreshTmuxJob(job, true);
			} catch {
				// Session already gone; the store removal below is what matters.
			}
			this.removeJob(job);
			throw new Error("Command aborted");
		}

		if (completed) {
			// Let the tmux pipe-pane flush the final output lines before reading logs.
			await delay(120);
			const current = this.refreshTmuxJob(job, true);
			const output = this.formatCompletedOutput(current);
			this.removeJob(job);
			if (current.exitCode !== 0 || current.signal) {
				const status = current.signal ? `Command killed by ${current.signal}` : `Command exited with code ${current.exitCode}`;
				throw new Error(output ? `${output}\n\n${status}` : status);
			}
			return {
				content: [{ type: "text" as const, text: output || "(no output)" }],
				details: undefined,
			};
		}

		this.jobs.set(job.id, job);
		return {
			content: [{ type: "text" as const, text: this.formatBackgrounded(job, foregroundSeconds) }],
			details: { job: publicJob(job), backgrounded: true, persistent: true },
		};
	}

	list(scope: JobScope = "current") {
		// A persistent job can outlive its tmux server; listing is also a
		// reconciliation pass, so a missing session is reported as killed.
		return this.readTmuxJobs(scope, true)
			.map(publicJob)
			.sort((left, right) => right.startedAt - left.startedAt);
	}

	waitForJobExit(signal?: AbortSignal): JobExitWait | undefined {
		if (signal?.aborted) return undefined;

		let settled = false;
		let resolvePromise!: (job: TmuxJob) => void;
		let rejectPromise!: (error: Error) => void;
		const promise = new Promise<TmuxJob>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});

		const cleanup = () => {
			this.jobExitWaiters.delete(waiter);
			signal?.removeEventListener("abort", abort);
		};
		const waiter = (job: TmuxJob) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolvePromise(job);
		};
		const abort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPromise(new Error("Sleep aborted"));
		};

		// Seed the watcher with currently-running jobs so an exit before its
		// first tick still wakes us.
		for (const job of this.readTmuxJobs("current", true)) {
			if (job.status === "running") this.watchIds.add(job.id);
		}
		this.jobExitWaiters.add(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		this.ensureExitWatcher();

		return {
			promise,
			cancel: () => {
				if (settled) return;
				settled = true;
				cleanup();
			},
		};
	}

	output(id: string, lines = DEFAULT_TAIL_LINES, scope: JobScope = "current") {
		const job = this.requireJob(id, scope);
		return { job, combined: tailFile(job.combinedFile, lines) };
	}

	async kill(id: string, scope: JobScope = "current") {
		const job = this.requireJob(id, scope);
		if (job.status !== "running") return job;

		if (tmuxSessionExists(job.tmuxSession)) runTmux(["kill-session", "-t", job.tmuxSession]);
		writeFileSync(job.statusFile, "killed\n");
		this.refreshTmuxJob(job, true);
		this.notifyJobExit(job);
		return job;
	}

	write(id: string, input: string, end = false, scope: JobScope = "current") {
		const job = this.requireJob(id, scope);
		if (job.status !== "running") throw new Error(`${id} is not running`);
		if (job.stdinClosed) throw new Error(`${id} stdin is closed`);

		if (input) {
			const bufferName = `pi-bg-${randomUUID()}`;
			runTmux(["load-buffer", "-b", bufferName, "-"], input);
			runTmux(["paste-buffer", "-d", "-b", bufferName, "-t", job.tmuxSession]);
		}
		if (end) {
			runTmux(["send-keys", "-t", job.tmuxSession, "C-d"]);
			job.stdinClosed = true;
			this.persistJob(job);
		}
		return job;
	}

	clearFinished(scope: JobScope = "current") {
		let cleared = 0;
		for (const job of this.readTmuxJobs(scope)) {
			if (job.status === "running") continue;
			this.removeJob(job);
			cleared++;
		}
		return cleared;
	}

	shutdown() {
		// Background jobs are persistent: leave tmux sessions and job stores
		// alone so a later Pi instance can recover them.
		if (this.exitWatcher) clearInterval(this.exitWatcher);
		this.exitWatcher = undefined;
		this.watchIds.clear();
		this.jobExitWaiters.clear();
		this.jobs.clear();
		this.currentSessionId = undefined;
	}

	private spawnTmux(command: string, cwd: string): TmuxJob {
		const ownerSessionId = this.requireCurrentSessionId();
		const version = spawnSync("tmux", ["-V"], { encoding: "utf8" });
		if (version.error) throw new Error(`tmux is required for persistent commands: ${version.error.message}`);
		if (version.status !== 0) throw new Error(version.stderr.trim() || "tmux is required for persistent commands");

		const id = `tmux_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
		const tmuxSession = `pi-bg-${id}`;
		const jobDir = join(TMUX_JOB_ROOT, id);
		const metadataFile = join(jobDir, "job.json");
		const statusFile = join(jobDir, "status");
		const scriptFile = join(jobDir, "run.sh");
		const gateFile = join(jobDir, "start");
		const combinedFile = join(jobDir, "combined.log");
		mkdirSync(jobDir, { recursive: true, mode: 0o700 });
		writeFileSync(combinedFile, "", { mode: 0o600 });

		const statusTempFile = `${statusFile}.tmp`;
		writeFileSync(scriptFile, [
			`#!${shellPath()}`,
			"set +e",
			`while [ ! -e ${shellQuote(gateFile)} ]; do sleep 0.05; done`,
			`rm -f ${shellQuote(gateFile)}`,
			`${shellQuote(shellPath())} -lc ${shellQuote(command)}`,
			"__pi_bg_status=$?",
			`printf '%s\\n' "$__pi_bg_status" > ${shellQuote(statusTempFile)}`,
			`mv -f ${shellQuote(statusTempFile)} ${shellQuote(statusFile)}`,
			'exit "$__pi_bg_status"',
			"",
		].join("\n"), { mode: 0o700 });

		try {
			const environment = Object.entries(process.env).flatMap(([name, value]) => value === undefined ? [] : ["-e", `${name}=${value}`]);
			runTmux(["new-session", "-d", "-s", tmuxSession, "-c", cwd, ...environment, shellPath(), scriptFile]);
			runTmux(["set-option", "-t", tmuxSession, "history-limit", String(TMUX_HISTORY_LINES)]);
			runTmux(["pipe-pane", "-o", "-t", tmuxSession, `cat >> ${shellQuote(combinedFile)}`]);
			const pid = Number(runTmux(["display-message", "-p", "-t", tmuxSession, "#{pane_pid}"]));
			const job: TmuxJob = {
				id,
				pid: Number.isFinite(pid) ? pid : -1,
				command,
				cwd,
				backend: "tmux",
				tmuxSession,
				status: "running",
				exitCode: null,
				signal: null,
				startedAt: Date.now(),
				endedAt: null,
				ownerSessionId,
				combinedFile,
				stdinClosed: false,
				jobDir,
				metadataFile,
				statusFile,
				scriptFile,
			};
			this.persistJob(job);
			writeFileSync(gateFile, "");
			return job;
		} catch (error) {
			if (tmuxSessionExists(tmuxSession)) runTmux(["kill-session", "-t", tmuxSession]);
			rmSync(jobDir, { recursive: true, force: true });
			throw error;
		}
	}

	private requireJob(id: string, scope: JobScope) {
		const cached = this.jobs.get(id);
		if (cached && this.inScope(cached, scope)) return this.refreshTmuxJob(cached, true);
		const job = this.readTmuxJobs(scope, true).find((candidate) => candidate.id === id);
		if (!job) {
			const qualifier = scope === "current" ? " in current-session scope" : "";
			throw new Error(`Unknown background job${qualifier}: ${id}`);
		}
		return job;
	}

	private readTmuxJobs(scope: JobScope, tolerateDisappeared = false) {
		const currentSessionId = this.requireCurrentSessionId();
		return readdirSync(TMUX_JOB_ROOT, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) => {
				const metadataFile = join(TMUX_JOB_ROOT, entry.name, "job.json");
				try {
					if (!existsSync(metadataFile)) return [];
					const job = parseTmuxMetadata(metadataFile, scope, currentSessionId);
					return job ? [this.refreshTmuxJob(job, tolerateDisappeared)] : [];
				} catch (error) {
					// Another Pi instance may clear a finished job while this one is polling it.
					if (isMissingPathError(error)) return [];
					throw error;
				}
			});
	}

	private requireCurrentSessionId() {
		if (!this.currentSessionId) throw new Error("Background jobs are unavailable before session initialization");
		return this.currentSessionId;
	}

	private inScope(job: TmuxJob, scope: JobScope) {
		return scope === "all" || job.ownerSessionId === this.requireCurrentSessionId();
	}

	private persistJob(job: TmuxJob) {
		const temporary = `${job.metadataFile}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(publicJob(job), null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, job.metadataFile);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}

	private refreshTmuxJob(job: TmuxJob, tolerateDisappeared = false) {
		if (existsSync(job.statusFile)) {
			if (tmuxSessionExists(job.tmuxSession)) {
				for (let attempt = 0; attempt < 100; attempt++) {
					const panes = spawnSync("tmux", tmuxArgs(["list-panes", "-t", job.tmuxSession, "-F", "#{pane_dead}"]), { cwd: tmuxCwd(), encoding: "utf8" });
					if (panes.status !== 0 || panes.stdout.trim() === "1") break;
					spawnSync("sleep", ["0.01"]);
				}
				const pane = spawnSync("tmux", tmuxArgs(["capture-pane", "-p", "-J", "-t", job.tmuxSession, "-S", `-${TMUX_HISTORY_LINES}`]), { cwd: tmuxCwd(), encoding: "utf8" });
				if (pane.status === 0 && pane.stdout) {
					const existing = readFileSync(job.combinedFile, "utf8");
					if (!existing.includes(pane.stdout)) appendFileSync(job.combinedFile, pane.stdout);
				}
				try {
					runTmux(["kill-session", "-t", job.tmuxSession]);
				} catch (error) {
					// The worker may have disappeared between has-session and
					// kill-session. Polling must reconcile that race without
					// taking down the host Pi process; explicit commands retain
					// the original tmux error for the caller.
					if (!tolerateDisappeared || !isMissingTmuxSessionError(error)) throw error;
				}
			}
			const status = readFileSync(job.statusFile, "utf8").trim();
			job.endedAt = statSync(job.statusFile).mtimeMs;
			if (status === "killed") {
				job.status = "killed";
				return job;
			}
			const exitCode = Number(status);
			if (!Number.isInteger(exitCode)) throw new Error(`Invalid tmux job status: ${job.statusFile}`);
			job.status = "exited";
			job.exitCode = exitCode;
			return job;
		}
		if (!tmuxSessionExists(job.tmuxSession)) {
			job.status = "killed";
			job.endedAt = Date.now();
		}
		return job;
	}

	private ensureExitWatcher() {
		if (this.exitWatcher) return;
		this.exitWatcher = setInterval(() => {
			if (this.jobExitWaiters.size === 0) {
				this.watchIds.clear();
				return;
			}
			const jobs = this.readTmuxJobs("current", true);
			const running = new Set<string>();
			for (const job of jobs) {
				if (job.status === "running") running.add(job.id);
			}
			for (const id of this.watchIds) {
				if (running.has(id)) continue;
				const exited = jobs.find((job) => job.id === id && job.status !== "running");
				if (exited) this.notifyJobExit(exited);
			}
			this.watchIds = running;
		}, 250);
	}

	private removeJob(job: TmuxJob) {
		try {
			if (tmuxSessionExists(job.tmuxSession)) runTmux(["kill-session", "-t", job.tmuxSession]);
		} catch {
			// The session may already have exited; removing the store is what matters.
		}
		rmSync(job.jobDir, { recursive: true, force: true });
		this.jobs.delete(job.id);
	}

	private notifyJobExit(job: TmuxJob) {
		if (!this.inScope(job, "current")) return;
		const waiters = [...this.jobExitWaiters];
		this.jobExitWaiters.clear();
		for (const waiter of waiters) waiter(job);
	}

	private formatCompletedOutput(job: TmuxJob) {
		return tailFile(job.combinedFile, DEFAULT_TAIL_LINES);
	}

	private formatBackgrounded(job: TmuxJob, foregroundSeconds: number) {
		const preview = this.formatCompletedOutput(job);
		const lines = [
			`Command is still running after ${foregroundSeconds.toFixed(1)}s; it continues in a persistent tmux background job.`,
			`id: ${job.id}`,
			`tmux session: ${job.tmuxSession}`,
			`pid: ${job.pid}`,
			`cwd: ${job.cwd}`,
			`combined: ${job.combinedFile}`,
			"It survives closing or switching Pi conversations; reopen this Pi session to recover it in current scope.",
			"Use bg_process to list, inspect output, kill, write to stdin, or clear. Use scope all explicitly from another session. Do not rerun the command just to check it.",
		];
		if (preview) lines.push("", "Recent output:", preview);
		return lines.join("\n");
	}
}

const formatDuration = (milliseconds: number) => {
	const seconds = Math.max(0, milliseconds) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${Math.floor(seconds % 60).toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
};

const formatJobLine = (job: PublicBackgroundJob, theme?: Theme) => {
	const status = `${job.status}${job.exitCode === null ? "" : `:${job.exitCode}`}`;
	const timing = job.status === "running"
		? `elapsed=${formatDuration(Date.now() - job.startedAt)}`
		: `duration=${formatDuration((job.endedAt ?? Date.now()) - job.startedAt)}`;
	const metadata = `pid=${job.pid} owner=${job.ownerSessionId ?? "unowned"} cwd=${JSON.stringify(job.cwd)} ${timing} tmux=${job.tmuxSession}`;
	const base = `${job.id} ${metadata} ${status} ${job.command}`;
	if (!theme) return base;
	const color = job.status === "running" ? "success" : job.status === "killed" ? "warning" : "muted";
	return `${theme.fg("accent", job.id)} ${theme.fg("dim", metadata)} ${theme.fg(color, status)} ${theme.fg("muted", job.command)}`;
};

const resultDetails = (action: ProcessDetails["action"], scope: JobScope, message: string, jobs: PublicBackgroundJob[]) => ({
	content: [{ type: "text" as const, text: message }],
	details: { action, scope, message, jobs } satisfies ProcessDetails,
});

export default function bgBashExtension(pi: ExtensionAPI) {
	const manager = new BackgroundBashManager();
	const pendingSleeps = new Set<AbortController>();
	const asyncCompletionWaiters = new Set<(event: AsyncJobCompletedEvent) => void>();
	const externalWakeWaiters = new Set<(wake: ExternalWake) => void>();
	const unsubscribeAsyncCompletion = pi.events?.on(ASYNC_JOB_COMPLETED_EVENT, (event) => {
		if (!isAsyncJobCompletedEvent(event)) return;
		const waiters = [...asyncCompletionWaiters];
		asyncCompletionWaiters.clear();
		for (const waiter of waiters) waiter(event);
	}) ?? (() => {});
	const unsubscribeSwarmActivity = pi.events?.on(AGENT_SWARM_ACTIVITY_EVENT, (event) => {
		const waiters = [...externalWakeWaiters];
		externalWakeWaiters.clear();
		for (const waiter of waiters) waiter({ type: "swarm", event });
	}) ?? (() => {});
	pi.on("input", (event) => {
		if (!event || typeof event !== "object" || (event as { streamingBehavior?: unknown }).streamingBehavior !== "steer") return;
		const waiters = [...externalWakeWaiters];
		externalWakeWaiters.clear();
		for (const waiter of waiters) waiter({ type: "steering" });
	});

	const waitForAsyncCompletion = (signal?: AbortSignal): AsyncCompletionWait | undefined => {
		if (signal?.aborted) return undefined;
		let settled = false;
		let resolvePromise!: (event: AsyncJobCompletedEvent) => void;
		let rejectPromise!: (error: Error) => void;
		const promise = new Promise<AsyncJobCompletedEvent>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		const cleanup = () => {
			asyncCompletionWaiters.delete(waiter);
			signal?.removeEventListener("abort", abort);
		};
		const waiter = (event: AsyncJobCompletedEvent) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolvePromise(event);
		};
		const abort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPromise(new Error("Sleep aborted"));
		};
		asyncCompletionWaiters.add(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		return {
			promise,
			cancel: () => {
				if (settled) return;
				settled = true;
				cleanup();
			},
		};
	};

	const waitForExternalWake = (signal?: AbortSignal): ExternalWakeWait | undefined => {
		if (signal?.aborted) return undefined;
		let settled = false;
		let resolvePromise!: (wake: ExternalWake) => void;
		let rejectPromise!: (error: Error) => void;
		const promise = new Promise<ExternalWake>((resolve, reject) => {
			resolvePromise = resolve;
			rejectPromise = reject;
		});
		const cleanup = () => {
			externalWakeWaiters.delete(waiter);
			signal?.removeEventListener("abort", abort);
		};
		const waiter = (wake: ExternalWake) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolvePromise(wake);
		};
		const abort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPromise(new Error("Sleep aborted"));
		};
		externalWakeWaiters.add(waiter);
		signal?.addEventListener("abort", abort, { once: true });
		return {
			promise,
			cancel: () => {
				if (settled) return;
				settled = true;
				cleanup();
			},
		};
	};

	pi.on("session_start", (_event, ctx) => {
		manager.bindSession(ctx.sessionManager.getSessionId());
	});

	pi.on("session_shutdown", async () => {
		for (const sleep of pendingSleeps) sleep.abort();
		unsubscribeAsyncCompletion();
		unsubscribeSwarmActivity();
		asyncCompletionWaiters.clear();
		externalWakeWaiters.clear();
		manager.shutdown();
	});

	pi.registerTool(withStatusCard({
		name: "bash",
		label: "zsh",
		description: `Execute a zsh command in the current working directory. Quick commands return normally. Commands still running after ${DEFAULT_GRACE_SECONDS}s continue in a persistent tmux background job owned by the current Pi session; reopen that session and use bg_process to inspect output, kill jobs, or write to stdin. The optional timeout parameter overrides that foreground grace period up to ${MAX_BASH_TIMEOUT_SECONDS}s. Output is truncated.`,
		promptSnippet: `Execute zsh commands; long-running commands auto-background into a persistent tmux job after at most ${MAX_BASH_TIMEOUT_SECONDS}s`,
		promptGuidelines: [
			"When bash returns a background job id, use bg_process to inspect, kill, or write to that job instead of rerunning the command.",
			"Background job details carry the owner, tmux session, and combined PTY log path; the job survives restarting Pi.",
			"Quick commands under the foreground grace period return directly and leave no background job.",
		],
		parameters: BashParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const command = params.command.trim();
			if (!command) throw new Error("bash command is required");
			if (params.timeout !== undefined) {
				if (!Number.isFinite(params.timeout)) throw new Error("timeout must be a finite number");
				if (params.timeout < 0.1) throw new Error("timeout must be >= 0.1");
				if (params.timeout > MAX_BASH_TIMEOUT_SECONDS) throw new Error(`timeout must be <= ${MAX_BASH_TIMEOUT_SECONDS}`);
			}
			const foregroundSeconds = params.timeout ?? DEFAULT_GRACE_SECONDS;
			return manager.run(command, ctx.cwd, foregroundSeconds, signal);
		},
		renderCall(args, theme) {
			const timeout = args.timeout ?? DEFAULT_GRACE_SECONDS;
			return new Text(theme.fg("toolTitle", theme.bold(`$ ${args.command ?? "..."}`)) + theme.fg("dim", ` (bg after ${timeout}s)`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("toolOutput", text?.type === "text" ? text.text : ""), 0, 0);
		},
	}));

	pi.registerTool(withStatusCard({
		name: "sleep",
		label: "Sleep",
		description: `Pause execution for a requested number of seconds, up to ${MAX_SLEEP_SECONDS} seconds. Sleep wakes early for current-session background job, subagent, or mixture completion, user steering, and agent-swarm activity. Use this when waiting for asynchronous work.`,
		promptSnippet: `Pause for a requested number of seconds, capped at ${MAX_SLEEP_SECONDS}s; wakes early for current-session background jobs, steering, or agent-swarm activity`,
		promptGuidelines: [
			`Use sleep when you need to wait before checking asynchronous work, but never request more than ${MAX_SLEEP_SECONDS} seconds.`,
			"Sleep wakes early when current-session managed background work completes, user steering arrives, or agent-swarm activity is delivered; do not use sleep when a fixed delay must ignore asynchronous completions.",
		],
		parameters: SleepParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			if (!Number.isFinite(params.seconds)) throw new Error("seconds must be a finite number");
			if (params.seconds < 0) throw new Error("seconds must be non-negative");
			if (params.seconds > MAX_SLEEP_SECONDS) throw new Error(`seconds must be <= ${MAX_SLEEP_SECONDS}`);

			const seconds = params.seconds;
			const startedAt = Date.now();
			const controller = new AbortController();
			const callerSignal = signal;
			const abort = () => controller.abort();
			if (callerSignal?.aborted) controller.abort();
			else callerSignal?.addEventListener("abort", abort, { once: true });
			pendingSleeps.add(controller);
			signal = controller.signal;
			const result = await (async () => {
				let jobExitWait: ReturnType<typeof manager.waitForJobExit>;
				let asyncCompletionWait: ReturnType<typeof waitForAsyncCompletion>;
				let externalWakeWait: ReturnType<typeof waitForExternalWake>;
				try {
					onUpdate?.({ content: [{ type: "text" as const, text: `Sleeping for ${seconds}s or until background work, steering, or agent-swarm activity arrives...` }] });
					jobExitWait = manager.waitForJobExit(signal);
					asyncCompletionWait = waitForAsyncCompletion(signal);
					externalWakeWait = waitForExternalWake(signal);
					return await Promise.race([
						delay(seconds * 1000, signal).then(() => ({ type: "timer" as const })),
						...(jobExitWait ? [jobExitWait.promise.then((job) => ({ type: "job" as const, job }))] : []),
						...(asyncCompletionWait ? [asyncCompletionWait.promise.then((event) => ({ type: "async" as const, event }))] : []),
						...(externalWakeWait ? [externalWakeWait.promise.then((wake) => ({ type: "external" as const, wake }))] : []),
					]);
				} finally {
					jobExitWait?.cancel();
					asyncCompletionWait?.cancel();
					externalWakeWait?.cancel();
					controller.abort();
					pendingSleeps.delete(controller);
					callerSignal?.removeEventListener("abort", abort);
				}
			})();

			if (result.type === "job") {
				const sleptSeconds = (Date.now() - startedAt) / 1000;
				const job = publicJob(result.job);
				const status = `${job.status}${job.exitCode === null ? "" : `:${job.exitCode}`}`;
				return {
					content: [{ type: "text" as const, text: `Woke after ${sleptSeconds.toFixed(1)}s because ${job.id} ${status}` }],
					details: { seconds, sleptSeconds, wokeEarly: true, job },
				};
			}
			if (result.type === "async") {
				const sleptSeconds = (Date.now() - startedAt) / 1000;
				return {
					content: [{ type: "text" as const, text: `Woke after ${sleptSeconds.toFixed(1)}s because ${result.event.id} ${result.event.status}` }],
					details: { seconds, sleptSeconds, wokeEarly: true, asyncJob: result.event },
				};
			}
			if (result.type === "external") {
				const sleptSeconds = (Date.now() - startedAt) / 1000;
				if (result.wake.type === "steering") {
					return {
						content: [{ type: "text" as const, text: `Woke after ${sleptSeconds.toFixed(1)}s because steering arrived` }],
						details: { seconds, sleptSeconds, wokeEarly: true, steering: true },
					};
				}
				return {
					content: [{ type: "text" as const, text: `Woke after ${sleptSeconds.toFixed(1)}s because agent-swarm activity arrived` }],
					details: { seconds, sleptSeconds, wokeEarly: true, agentSwarm: result.wake.event },
				};
			}

			return {
				content: [{ type: "text" as const, text: `Slept for ${seconds}s` }],
				details: { seconds, wokeEarly: false },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(`sleep ${args.seconds ?? "..."}s`)), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
		},
	}));

	pi.registerTool(withStatusCard({
		name: "bg_process",
		label: "Background Process",
		description: `Manage zsh commands that run as persistent tmux background jobs. Jobs default to the current Pi session and remain available when that session is reopened. Set scope to all explicitly to inspect or administer foreign and legacy jobs. Actions: list, output (id, optional lines up to ${MAX_TAIL_LINES}), kill (id), write (id, input, optional end), clear.`,
		promptSnippet: "List, inspect, kill, clear, or send stdin to current-session persistent tmux jobs; scope all is explicit",
		promptGuidelines: [
			"Use bg_process after bash reports that a command moved to the background.",
			"Current-session scope is the default and recovers jobs when the same Pi session is reopened.",
			"Use scope all only when the user needs to inspect or administer another session's or an unowned legacy job.",
			"Use bg_process output for recent combined PTY output and kill for no-longer-needed background jobs.",
		],
		parameters: BgProcessParams,
		async execute(_toolCallId, params) {
			const scope = params.scope ?? "current";
			if (scope !== "current" && scope !== "all") throw new Error("scope must be current or all");
			if (params.lines !== undefined) {
				if (!Number.isFinite(params.lines) || !Number.isInteger(params.lines)) throw new Error("lines must be an integer");
				if (params.lines < 1) throw new Error("lines must be >= 1");
				if (params.lines > MAX_TAIL_LINES) throw new Error(`lines must be <= ${MAX_TAIL_LINES}`);
			}

			switch (params.action) {
				case "list": {
					const jobs = manager.list(scope);
					const message = jobs.length ? jobs.map((job) => formatJobLine(job)).join("\n") : "No background jobs";
					return resultDetails("list", scope, message, jobs);
				}
				case "output": {
					if (!params.id) throw new Error("id is required for output");
					const { job, combined } = manager.output(params.id, params.lines ?? DEFAULT_TAIL_LINES, scope);
					const chunks = [formatJobLine(publicJob(job)), `combined: ${job.combinedFile}`];
					if (combined) chunks.push("", "OUTPUT:", combined);
					return resultDetails("output", scope, chunks.join("\n"), [publicJob(job)]);
				}
				case "kill": {
					if (!params.id) throw new Error("id is required for kill");
					const job = await manager.kill(params.id, scope);
					const message = job.status === "running" ? `Sent termination signal to ${job.id}` : `${job.id} is ${job.status}`;
					return resultDetails("kill", scope, message, [publicJob(job)]);
				}
				case "write": {
					if (!params.id) throw new Error("id is required for write");
					if (params.input === undefined) throw new Error("input is required for write");
					const job = manager.write(params.id, params.input, params.end ?? false, scope);
					return resultDetails("write", scope, `Wrote ${params.input.length} chars to ${job.id}${params.end ? " and closed stdin" : ""}`, [publicJob(job)]);
				}
				case "clear": {
					const count = manager.clearFinished(scope);
					return resultDetails("clear", scope, `Cleared ${count} finished background job(s)`, manager.list(scope));
				}
				default:
					throw new Error(`Unknown bg_process action: ${String(params.action)}`);
			}
		},
		renderCall(args, theme) {
			const parameters = [
				args.id !== undefined ? theme.fg("accent", args.id) : undefined,
				args.input !== undefined ? theme.fg("toolOutput", JSON.stringify(args.input)) : undefined,
				args.lines !== undefined ? theme.fg("dim", `lines=${args.lines}`) : undefined,
				args.end !== undefined ? theme.fg("dim", `end=${args.end}`) : undefined,
				args.scope !== undefined ? theme.fg("dim", `scope=${args.scope}`) : undefined,
			].filter((parameter): parameter is string => parameter !== undefined);
			const suffix = parameters.length ? ` ${parameters.join(" ")}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("bg_process ")) + theme.fg("muted", args.action) + suffix, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as ProcessDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.action === "list" && details.jobs.length > 0) {
				const shown = expanded ? details.jobs : details.jobs.slice(0, 8);
				let text = shown.map((job) => formatJobLine(job, theme)).join("\n");
				if (!expanded && details.jobs.length > shown.length) text += `\n${theme.fg("dim", `... ${details.jobs.length - shown.length} more`)}`;
				return new Text(text, 0, 0);
			}
			return new Text(theme.fg("muted", details.message), 0, 0);
		},
	}));

	pi.registerCommand("bg", {
		description: "List or manage current-session background jobs. Add --all for foreign and legacy jobs: /bg [--all] [list|output <id>|kill <id>|write <id> <text>|clear]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const allIndex = parts.indexOf("--all");
			const scope: JobScope = allIndex === -1 ? "current" : "all";
			if (allIndex !== -1) parts.splice(allIndex, 1);
			const [action = "list", id, ...rest] = parts;
			try {
				if (action === "list") {
					const jobs = manager.list(scope);
					ctx.ui.notify(jobs.length ? jobs.map((job) => formatJobLine(job)).join("\n") : "No background jobs", "info");
					return;
				}
				if (action === "output") {
					if (!id) throw new Error("Usage: /bg output <id>");
					const { job, combined } = manager.output(id, DEFAULT_TAIL_LINES, scope);
					const output = [formatJobLine(publicJob(job)), combined && `OUTPUT:\n${combined}`];
					ctx.ui.notify(output.filter(Boolean).join("\n\n"), "info");
					return;
				}
				if (action === "kill") {
					if (!id) throw new Error("Usage: /bg kill <id>");
					await manager.kill(id, scope);
					ctx.ui.notify(`Sent termination signal to ${id}`, "info");
					return;
				}
				if (action === "write") {
					if (!id || rest.length === 0) throw new Error("Usage: /bg write <id> <text>");
					manager.write(id, rest.join(" "), false, scope);
					ctx.ui.notify(`Wrote to ${id}`, "info");
					return;
				}
				if (action === "clear") {
					ctx.ui.notify(`Cleared ${manager.clearFinished(scope)} finished background job(s)`, "info");
					return;
				}
				throw new Error(`Unknown /bg action: ${action}`);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
