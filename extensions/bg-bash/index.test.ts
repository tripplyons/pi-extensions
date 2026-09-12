import { afterAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

class MockBox {
	children: any[] = [];
	background?: (text: string) => string;

	addChild(child: any) { this.children.push(child); }
	clear() { this.children = []; }
	invalidate() {}
	setBgFn(background: (text: string) => string) { this.background = background; }
	render(width: number) {
		return this.children
			.flatMap((child) => child.render(width))
			.map((line) => this.background?.(line) ?? line);
	}
}

class MockText {
	constructor(public text: string) {}
	invalidate() {}
	render() { return this.text.split("\n"); }
}

mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[]) => ({ type: "string", enum: [...values] }),
}));
mock.module("typebox", () => ({
	Type: {
		Boolean: (options: object) => ({ type: "boolean", ...options }),
		Number: (options: object) => ({ type: "number", ...options }),
		Object: (properties: object) => ({ type: "object", properties }),
		Optional: (schema: object) => schema,
		String: (options: object = {}) => ({ type: "string", ...options }),
	},
}));
mock.module("@earendil-works/pi-tui", () => ({
	Box: MockBox,
	Container: class {
		invalidate() {}
		render() { return []; }
	},
	Text: MockText,
	truncateToWidth: (text: string, width: number) => text.slice(0, width),
	visibleWidth: (text: string) => text.length,
}));

const previousCacheHome = process.env.XDG_CACHE_HOME;
const testCacheHome = mkdtempSync(join(tmpdir(), "pi-bg-bash-tests-"));
const previousSocket = process.env.PI_BG_BASH_TMUX_SOCKET;
const socketDirectory = join(testCacheHome, "long-worker-path-".repeat(8));
mkdirSync(socketDirectory);
process.env.PI_BG_BASH_TMUX_SOCKET = join(socketDirectory, "bg.sock");
const testTmux = (args: string[]) => Bun.spawnSync(["tmux", "-S", "bg.sock", ...args], { cwd: socketDirectory });
process.env.XDG_CACHE_HOME = testCacheHome;
const { default: bgBashExtension } = await import("./index.ts");

afterAll(() => {
	testTmux(["kill-server"]);
	rmSync(testCacheHome, { recursive: true, force: true });
	if (previousSocket === undefined) delete process.env.PI_BG_BASH_TMUX_SOCKET;
	else process.env.PI_BG_BASH_TMUX_SOCKET = previousSocket;
	if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = previousCacheHome;
});

const theme = {
	bg: (_role: string, text: string) => text,
	bold: (text: string) => text,
	fg: (_role: string, text: string) => text,
};

const bindTestSession = (event: string, handler: Function, sessionId = "bg-test-session") => {
	if (event === "session_start") handler({}, { sessionManager: { getSessionId: () => sessionId } });
};

const cacheRoot = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi", "bg-bash");

const createHarness = (sessionId: string) => {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	bgBashExtension({
		on(event: string, handler: Function) { handlers.set(event, handler); },
		registerCommand() {},
		registerTool(tool: any) { tools.set(tool.name, tool); },
	} as any);
	const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => sessionId } };
	handlers.get("session_start")?.({}, ctx);
	return {
		tools,
		shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
	};
};

const createStoredJob = (options: {
	id: string;
	ownerSessionId?: string;
	output?: string;
	status?: string;
	startedAt?: number;
}) => {
	const jobDir = join(cacheRoot, options.id);
	const tmuxSession = `pi-bg-${options.id}`;
	mkdirSync(jobDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(jobDir, "job.json"), `${JSON.stringify({
		id: options.id,
		pid: 1234,
		command: `command-${options.id}`,
		cwd: "/tmp/bg cwd",
		tmuxSession,
		startedAt: options.startedAt ?? Date.now() - 2_000,
		...(options.ownerSessionId === undefined ? {} : { ownerSessionId: options.ownerSessionId }),
		stdinClosed: false,
		stdoutFile: join(jobDir, "obsolete-stdout.log"),
		stderrFile: join(jobDir, "obsolete-stderr.log"),
	}, null, 2)}\n`);
	writeFileSync(join(jobDir, "combined.log"), options.output ?? `${options.id}\n`);
	if (options.status !== undefined) writeFileSync(join(jobDir, "status"), `${options.status}\n`);
	return jobDir;
};

describe("bg_process rendering", () => {
	test("shows every subcommand and its parameters", async () => {
		let shutdown: (() => Promise<void>) | undefined;
		const tools = new Map<string, any>();
		const pi = {
			on(event: string, handler: () => Promise<void>) {
				bindTestSession(event, handler);
				if (event === "session_shutdown") shutdown = handler;
			},
			registerCommand() {},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		};

		bgBashExtension(pi as any);
		const tool = tools.get("bg_process");
		const renderCall = (args: object) => {
			const component = tool.renderCall(args, theme, {
				state: {},
				isPartial: false,
				isError: false,
				lastComponent: undefined,
			});
			return component.render(100).map((line: string) => line.trim()).filter(Boolean)[0];
		};

		expect([
			renderCall({ action: "list" }),
			renderCall({ action: "output", id: "bg_1", lines: 40 }),
			renderCall({ action: "kill", id: "bg_2" }),
			renderCall({ action: "write", id: "bg_3", input: "yes\n", end: true }),
			renderCall({ action: "clear", scope: "all" }),
		]).toEqual([
			"✓ bg_process list",
			"✓ bg_process output bg_1 lines=40",
			"✓ bg_process kill bg_2",
			'✓ bg_process write bg_3 "yes\\n" end=true',
			"✓ bg_process clear scope=all",
		]);
		await shutdown?.();
	});
});

describe("background job ownership and output", () => {
	test("defaults every stored-job operation to the current owner and gates legacy jobs behind all scope", async () => {
		const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const ids = {
			current: `tmux_scope_current_${suffix}`,
			foreign: `tmux_scope_foreign_${suffix}`,
			legacy: `tmux_scope_legacy_${suffix}`,
		};
		const harness = createHarness(`owner-current-${suffix}`);
		const directories = [
			createStoredJob({ id: ids.current, ownerSessionId: `owner-current-${suffix}`, status: "0" }),
			createStoredJob({ id: ids.foreign, ownerSessionId: `owner-foreign-${suffix}`, status: "0" }),
			createStoredJob({ id: ids.legacy, status: "0" }),
		];

		try {
			const currentList = await harness.tools.get("bg_process").execute("list-current", { action: "list" });
			expect(currentList.details.jobs.map((job: { id: string }) => job.id)).toEqual([ids.current]);
			expect(currentList.content[0].text).toContain(`owner=owner-current-${suffix}`);
			expect(currentList.content[0].text).toContain('cwd="/tmp/bg cwd"');
			expect(currentList.content[0].text).toContain("duration=");

			const allList = await harness.tools.get("bg_process").execute("list-all", { action: "list", scope: "all" });
			expect(new Set(allList.details.jobs.map((job: { id: string }) => job.id))).toEqual(new Set(Object.values(ids)));
			expect(allList.content[0].text).toContain("owner=unowned");
			expect(allList.details.jobs.every((job: object) => !("stdoutFile" in job) && !("stderrFile" in job))).toBe(true);

			await expect(harness.tools.get("bg_process").execute("foreign-output", { action: "output", id: ids.foreign }))
				.rejects.toThrow("current-session scope");
			const foreignOutput = await harness.tools.get("bg_process").execute("foreign-output-all", {
				action: "output",
				id: ids.foreign,
				scope: "all",
			});
			expect(foreignOutput.content[0].text).toContain(ids.foreign);

			await harness.tools.get("bg_process").execute("clear-current", { action: "clear" });
			expect(existsSync(directories[0])).toBe(false);
			expect(existsSync(directories[1])).toBe(true);
			expect(existsSync(directories[2])).toBe(true);

			await harness.tools.get("bg_process").execute("clear-all", { action: "clear", scope: "all" });
			expect(existsSync(directories[1])).toBe(false);
			expect(existsSync(directories[2])).toBe(false);
		} finally {
			for (const directory of directories) rmSync(directory, { recursive: true, force: true });
			await harness.shutdown();
		}
	});

	test("tails large transcripts from the end and rejects invalid operations", async () => {
		const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const id = `tmux_tail_${suffix}`;
		const ownerSessionId = `owner-tail-${suffix}`;
		const harness = createHarness(ownerSessionId);
		const jobDir = createStoredJob({
			id,
			ownerSessionId,
			status: "0",
			output: `${"old-line\n".repeat(100_000)}last-one\nlast-two\n`,
		});

		try {
			const result = await harness.tools.get("bg_process").execute("tail", { action: "output", id, lines: 2 });
			const output = result.content[0].text.split("OUTPUT:\n")[1];
			expect(output).toBe("last-one\nlast-two");
			for (const lines of [0, 2.5, 2_001, Number.NaN]) {
				await expect(harness.tools.get("bg_process").execute("bad-lines", { action: "output", id, lines }))
					.rejects.toThrow();
			}
			await expect(harness.tools.get("bg_process").execute("missing-id", { action: "output", id: `missing_${suffix}` }))
				.rejects.toThrow("Unknown background job");
			await expect(harness.tools.get("bg_process").execute("missing-parameter", { action: "kill" }))
				.rejects.toThrow("id is required");
		} finally {
			rmSync(jobDir, { recursive: true, force: true });
			await harness.shutdown();
		}
	});

	test("removes terminal cursor controls from stored PTY output", async () => {
		const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const id = `tmux_controls_${suffix}`;
		const ownerSessionId = `owner-controls-${suffix}`;
		const harness = createHarness(ownerSessionId);
		const jobDir = createStoredJob({
			id,
			ownerSessionId,
			status: "0",
			output: "\x1b[?1h\x1b=first\rsecond\b!\x1b[2J\x1b]0;bad title\x07\r\n\x1b[31mred\x1b[0m\n",
		});

		try {
			const result = await harness.tools.get("bg_process").execute("controls", { action: "output", id });
			const output = result.content[0].text.split("OUTPUT:\n")[1];
			expect(output).toBe("first\nsecond!\nred");
			expect(output).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
		} finally {
			rmSync(jobDir, { recursive: true, force: true });
			await harness.shutdown();
		}
	});
});

describe("sleep async completion", () => {
	test("timeout, cancellation, and shutdown settle pending sleeps", async () => {
		const harness = createHarness("sleep-cleanup-test");
		const sleep = harness.tools.get("sleep");
		try {
			const timed = await sleep.execute("timeout", { seconds: 0.01 });
			const setupSignal = new AbortController().signal;
			let attached = 0;
			let removed = 0;
			const add = setupSignal.addEventListener.bind(setupSignal);
			const remove = setupSignal.removeEventListener.bind(setupSignal);
			setupSignal.addEventListener = (...args: any[]) => { attached++; add(...args); };
			setupSignal.removeEventListener = (...args: any[]) => { removed++; remove(...args); };
			await expect(sleep.execute("setup-error", { seconds: 30 }, setupSignal, () => { throw new Error("update failed"); })).rejects.toThrow("update failed");
			expect(attached).toBe(removed);
			expect(timed.details.wokeEarly).toBe(false);
			const controller = new AbortController();
			const cancelled = sleep.execute("cancel", { seconds: 30 }, controller.signal).catch((error: Error) => error);
			controller.abort();
			expect((await cancelled).message).toBe("Sleep aborted");
			const pending = sleep.execute("shutdown", { seconds: 30 }).catch((error: Error) => error);
			await harness.shutdown();
			expect((await pending).message).toBe("Sleep aborted");
		} finally {
			await harness.shutdown();
		}
	});

	test("wakes when a subagent completion event arrives", async () => {
		let shutdown: (() => Promise<void>) | undefined;
		const eventHandlers = new Map<string, (event: unknown) => void>();
		const tools = new Map<string, any>();
		bgBashExtension({
			events: {
				emit() {},
				on(channel: string, handler: (event: unknown) => void) {
					eventHandlers.set(channel, handler);
					return () => { eventHandlers.delete(channel); };
				},
			},
			on(event: string, handler: () => Promise<void>) {
				bindTestSession(event, handler);
				if (event === "session_shutdown") shutdown = handler;
			},
			registerCommand() {},
			registerTool(tool: any) { tools.set(tool.name, tool); },
		} as any);

		const sleeping = tools.get("sleep").execute("sleep", { seconds: 30 }, undefined, undefined, {});
		await Bun.sleep(1);
		eventHandlers.get("tripp:async-job-completed")?.({ source: "subagent", id: "sub_1", status: "exited" });
		const result = await sleeping;

		expect(result.content[0].text).toContain("sub_1 exited");
		expect(result.details).toMatchObject({ wokeEarly: true, asyncJob: { id: "sub_1" } });
		await shutdown?.();
	});

	test("wakes for steering and agent-swarm activity", async () => {
		let shutdown: (() => Promise<void>) | undefined;
		let inputHandler: ((event: unknown) => void) | undefined;
		const eventHandlers = new Map<string, (event: unknown) => void>();
		const tools = new Map<string, any>();
		bgBashExtension({
			events: {
				emit() {},
				on(channel: string, handler: (event: unknown) => void) {
					eventHandlers.set(channel, handler);
					return () => { eventHandlers.delete(channel); };
				},
			},
			on(event: string, handler: (value?: unknown) => Promise<void>) {
				bindTestSession(event, handler);
				if (event === "input") inputHandler = handler as (event: unknown) => void;
				if (event === "session_shutdown") shutdown = handler as () => Promise<void>;
			},
			registerCommand() {},
			registerTool(tool: any) { tools.set(tool.name, tool); },
		} as any);

		const steeringSleep = tools.get("sleep").execute("sleep", { seconds: 30 }, undefined, undefined, {});
		await Bun.sleep(1);
		inputHandler?.({ streamingBehavior: "steer" });
		const steeringResult = await steeringSleep;
		expect(steeringResult.content[0].text).toContain("steering arrived");
		expect(steeringResult.details).toMatchObject({ wokeEarly: true, steering: true });

		const swarmSleep = tools.get("sleep").execute("sleep", { seconds: 30 }, undefined, undefined, {});
		await Bun.sleep(1);
		eventHandlers.get("tripp:agent-swarm-activity")?.({ kind: "message", nodeId: "node_1" });
		const swarmResult = await swarmSleep;
		expect(swarmResult.content[0].text).toContain("agent-swarm activity arrived");
		expect(swarmResult.details).toMatchObject({ wokeEarly: true, agentSwarm: { kind: "message" } });
		await shutdown?.();
	});
});

describe("zsh execution and persistent tmux", () => {
	const tmuxAvailable = testTmux(["-V"]).exitCode === 0;
	const tmuxTest = tmuxAvailable ? test : test.skip;

	tmuxTest("backgrounded jobs are shared between concurrent extension instances", async () => {
		const createInstance = () => {
			let shutdown: (() => Promise<void>) | undefined;
			const tools = new Map<string, any>();
			bgBashExtension({
				on(event: string, handler: () => Promise<void>) {
					bindTestSession(event, handler);
					if (event === "session_shutdown") shutdown = handler;
				},
				registerCommand() {},
				registerTool(tool: any) { tools.set(tool.name, tool); },
			} as any);
			return { tools, shutdown: () => shutdown?.() };
		};
		const cleanJob = (id: string) => {
			const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
			rmSync(join(cacheHome, "pi", "bg-bash", id), { recursive: true, force: true });
		};

		const first = createInstance();
		const second = createInstance();
		let jobId: string | undefined;

		try {
			const started = await second.tools.get("bash").execute(
				"shared-job",
				{ command: "sleep 0.3; printf 'still-alive\\n'", timeout: 0.1 },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			);
			jobId = started.details.job.id;
			expect(started.details.job.backend).toBe("tmux");

			await first.shutdown();
			await Bun.sleep(500);
			const output = await second.tools.get("bg_process").execute(
				"shared-output",
				{ action: "output", id: jobId },
			);
			expect(output.content[0].text).toContain("still-alive");
		} finally {
			await first.shutdown();
			await second.shutdown();
			if (jobId) cleanJob(jobId);
		}
	});

	tmuxTest("requires all scope to write to or kill a foreign running job", async () => {
		const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const foreign = createHarness(`owner-foreign-${suffix}`);
		const current = createHarness(`owner-current-${suffix}`);
		let job: { id: string; tmuxSession: string } | undefined;

		try {
			const started = await foreign.tools.get("bash").execute(
				"foreign-running",
				{ command: "cat; sleep 30", timeout: 0.1 },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			);
			job = started.details.job;
			const listed = await current.tools.get("bg_process").execute("foreign-list-all", { action: "list", scope: "all" });
			expect(listed.content[0].text).toContain(`owner=owner-foreign-${suffix}`);
			expect(listed.content[0].text).toContain("elapsed=");
			await expect(current.tools.get("bg_process").execute("foreign-write", {
				action: "write",
				id: job?.id,
				input: "foreign input\n",
			})).rejects.toThrow("current-session scope");
			await expect(current.tools.get("bg_process").execute("foreign-kill", { action: "kill", id: job?.id }))
				.rejects.toThrow("current-session scope");

			const written = await current.tools.get("bg_process").execute("foreign-write-all", {
				action: "write",
				id: job?.id,
				input: "foreign input\n",
				scope: "all",
			});
			expect(written.details.jobs[0].ownerSessionId).toBe(`owner-foreign-${suffix}`);
			await current.tools.get("bg_process").execute("foreign-kill-all", { action: "kill", id: job?.id, scope: "all" });
		} finally {
			if (job) {
				testTmux(["kill-session", "-t", job.tmuxSession]);
				rmSync(join(cacheRoot, job.id), { recursive: true, force: true });
			}
			await foreign.shutdown();
			await current.shutdown();
		}
	});

	tmuxTest("persists stdin closure and recovers it in the owning session", async () => {
		const sessionId = `owner-stdin-${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const first = createHarness(sessionId);
		let second: ReturnType<typeof createHarness> | undefined;
		let job: { id: string; tmuxSession: string } | undefined;

		try {
			const started = await first.tools.get("bash").execute(
				"stdin-running",
				{ command: "cat; sleep 30", timeout: 0.1 },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			);
			job = started.details.job;
			const closed = await first.tools.get("bg_process").execute("close-stdin", {
				action: "write",
				id: job?.id,
				input: "",
				end: true,
			});
			expect(closed.details.jobs[0].stdinClosed).toBe(true);

			const metadata = JSON.parse(readFileSync(join(cacheRoot, job!.id, "job.json"), "utf8"));
			expect(metadata).toMatchObject({ ownerSessionId: sessionId, stdinClosed: true, combinedFile: join(cacheRoot, job!.id, "combined.log") });
			expect(metadata.stdoutFile).toBeUndefined();
			expect(metadata.stderrFile).toBeUndefined();
			expect(existsSync(join(cacheRoot, job!.id, "stdout.log"))).toBe(false);
			expect(existsSync(join(cacheRoot, job!.id, "stderr.log"))).toBe(false);

			await first.shutdown();
			second = createHarness(sessionId);
			const recovered = await second.tools.get("bg_process").execute("recover", { action: "list" });
			expect(recovered.details.jobs.find((candidate: { id: string }) => candidate.id === job?.id)?.stdinClosed).toBe(true);
			await expect(second.tools.get("bg_process").execute("write-after-close", {
				action: "write",
				id: job?.id,
				input: "too late\n",
			})).rejects.toThrow("stdin is closed");
			await second.tools.get("bg_process").execute("kill-after-recovery", { action: "kill", id: job?.id });
		} finally {
			if (job) {
				testTmux(["kill-session", "-t", job.tmuxSession]);
				rmSync(join(cacheRoot, job.id), { recursive: true, force: true });
			}
			await first.shutdown();
			await second?.shutdown();
		}
	});

	tmuxTest("sleep ignores foreign exits and wakes for a current-session exit", async () => {
		const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const foreign = createHarness(`owner-foreign-sleep-${suffix}`);
		const current = createHarness(`owner-current-sleep-${suffix}`);
		const jobs: Array<{ id: string; tmuxSession: string }> = [];

		try {
			const foreignStarted = await foreign.tools.get("bash").execute(
				"foreign-sleep",
				{ command: "sleep 0.3", timeout: 0.1 },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			);
			jobs.push(foreignStarted.details.job);
			const ignored = await current.tools.get("sleep").execute("ignore-foreign", { seconds: 0.45 });
			expect(ignored.details.wokeEarly).toBe(false);

			const currentStarted = await current.tools.get("bash").execute(
				"current-sleep",
				{ command: "sleep 0.35", timeout: 0.1 },
				undefined,
				undefined,
				{ cwd: process.cwd() },
			);
			jobs.push(currentStarted.details.job);
			const woke = await current.tools.get("sleep").execute("wake-current", { seconds: 2 });
			expect(woke.details).toMatchObject({ wokeEarly: true, job: { id: currentStarted.details.job.id } });
		} finally {
			for (const job of jobs) {
				testTmux(["kill-session", "-t", job.tmuxSession]);
				rmSync(join(cacheRoot, job.id), { recursive: true, force: true });
			}
			await foreign.shutdown();
			await current.shutdown();
		}
	});

	tmuxTest("executes commands with zsh", async () => {
		let shutdown: (() => Promise<void>) | undefined;
		const tools = new Map<string, any>();
		const pi = {
			on(event: string, handler: () => Promise<void>) {
				bindTestSession(event, handler);
				if (event === "session_shutdown") shutdown = handler;
			},
			registerCommand() {},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		};

		bgBashExtension(pi as any);
		const result = await tools.get("bash").execute(
			"zsh-version",
			{ command: "printf '%s' $ZSH_VERSION" },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);

		expect(result.content[0].text).toMatch(/^5\./);
		const previous = process.env.PYTHONPYCACHEPREFIX;
		testTmux(["new-session", "-d", "-s", "environment-holder", "sleep 30"]);
		try {
			for (const directory of ["first-bytecode", "second-bytecode"]) {
				process.env.PYTHONPYCACHEPREFIX = join(testCacheHome, directory);
				const output = await tools.get("bash").execute("environment", {
					command: 'printf "%s" "$PYTHONPYCACHEPREFIX"',
				}, undefined, undefined, { cwd: process.cwd() });
				expect(output.content[0].text).toBe(process.env.PYTHONPYCACHEPREFIX);
			}
		} finally {
			testTmux(["kill-session", "-t", "environment-holder"]);
			if (previous === undefined) delete process.env.PYTHONPYCACHEPREFIX;
			else process.env.PYTHONPYCACHEPREFIX = previous;
		}
		await shutdown?.();
	});

	test("backgrounds after the grace period with no persistence flag", async () => {
		let shutdown: (() => Promise<void>) | undefined;
		const tools = new Map<string, any>();
		const pi = {
			on(event: string, handler: () => Promise<void>) {
				bindTestSession(event, handler);
				if (event === "session_shutdown") shutdown = handler;
			},
			registerCommand() {},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		};

		bgBashExtension(pi as any);
		const tool = tools.get("bash");
		const component = tool.renderCall({ command: "make release", timeout: 10 }, theme, {
			state: {},
			isPartial: false,
			isError: false,
			lastComponent: undefined,
		});

		expect(tool.parameters.properties.tmux).toBeUndefined();
		expect(tool.parameters.properties.timeout.type).toBe("number");
		expect(component.render(100).map((line: string) => line.trim()).filter(Boolean)[0]).toBe("✓ $ make release (bg after 10s)");
		await shutdown?.();
	});

	test("background refresh tolerates a session disappearing during kill", async () => {
		let shutdown: (() => Promise<void>) | undefined;
		const tools = new Map<string, any>();
		bgBashExtension({
			on(event: string, handler: () => Promise<void>) {
				bindTestSession(event, handler);
				if (event === "session_shutdown") shutdown = handler;
			},
			registerCommand() {},
			registerTool(tool: any) { tools.set(tool.name, tool); },
		} as any);

		const id = `tmux_refresh_race_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
		const jobDir = join(cacheHome, "pi", "bg-bash", id);
		const tmuxSession = `pi-bg-${id}`;
		const fakeTmuxDir = mkdtempSync(join(tmpdir(), "pi-bg-fake-tmux-"));
		const fakeTmux = join(fakeTmuxDir, "tmux");
		writeFileSync(fakeTmux, [
			"#!/bin/sh",
			`target=${JSON.stringify(tmuxSession)}`,
			'case "$1" in',
			'  has-session) [ "$3" = "$target" ] && exit 0 || exit 1 ;;',
			'  list-panes|capture-pane) exit 1 ;;',
			'  kill-session) echo "can\'t find session: $3" >&2; exit 1 ;;',
			'  *) exit 1 ;;',
			'esac',
			"",
		].join("\n"), { mode: 0o700 });
		mkdirSync(jobDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(jobDir, "job.json"), `${JSON.stringify({ id, command: "sleep 30", cwd: process.cwd(), pid: 1234, startedAt: Date.now(), tmuxSession })}\n`);
		writeFileSync(join(jobDir, "combined.log"), "");
		writeFileSync(join(jobDir, "status"), "0\n");
		const previousPath = process.env.PATH;
		process.env.PATH = `${fakeTmuxDir}${previousPath ? `:${previousPath}` : ""}`;

		try {
			const result = await tools.get("bg_process").execute("refresh-race-list", { action: "list", scope: "all" });
			expect(result.details.jobs.find((candidate: { id: string }) => candidate.id === id)).toMatchObject({ status: "exited", exitCode: 0 });
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			rmSync(jobDir, { recursive: true, force: true });
			rmSync(fakeTmuxDir, { recursive: true, force: true });
			await shutdown?.();
		}
	});

	tmuxTest("survives extension shutdown and is recovered by a new instance", async () => {
		const createInstance = () => {
			let shutdown: (() => Promise<void>) | undefined;
			const tools = new Map<string, any>();
			const pi = {
				on(event: string, handler: () => Promise<void>) {
					bindTestSession(event, handler);
					if (event === "session_shutdown") shutdown = handler;
				},
				registerCommand() {},
				registerTool(tool: any) {
					tools.set(tool.name, tool);
				},
			};
			bgBashExtension(pi as any);
			return { tools, shutdown: () => shutdown?.() };
		};

		const first = createInstance();
		const started = await first.tools.get("bash").execute(
			"tmux-start",
			{ command: "printf 'persistent-start\\n'; sleep 0.2; printf 'persistent-done\\n'", timeout: 0.1 },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		const job = started.details.job as { id: string; tmuxSession: string };
		testTmux(["set-option", "-t", job.tmuxSession, "remain-on-exit", "on"]);
		let second: ReturnType<typeof createInstance> | undefined;

		try {
			await first.shutdown();
			second = createInstance();
			const bgProcess = second.tools.get("bg_process");
			let output = "";
			let recovered: { id: string; status: string } | undefined;
			for (let attempt = 0; attempt < 100 && (recovered?.status !== "exited" || !(output.split("OUTPUT:\n")[1] ?? "").includes("persistent-done")); attempt++) {
				await Bun.sleep(50);
				const result = await bgProcess.execute("tmux-output", { action: "output", id: job.id });
				output = result.content[0].text;
				const listed = await bgProcess.execute("tmux-list", { action: "list" });
				recovered = listed.details.jobs.find((candidate: { id: string }) => candidate.id === job.id);
			}

			const capturedOutput = output.split("OUTPUT:\n")[1] ?? "";
			expect(capturedOutput).toContain("persistent-start");
			expect(capturedOutput).toContain("persistent-done");
			expect(recovered).toMatchObject({ backend: "tmux", status: "exited", exitCode: 0 });
			expect(testTmux(["has-session", "-t", job.tmuxSession]).exitCode).not.toBe(0);
		} finally {
			testTmux(["kill-session", "-t", job.tmuxSession]);
			const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
			rmSync(join(cacheHome, "pi", "bg-bash", job.id), { recursive: true, force: true });
			await second?.shutdown();
		}
	});

	tmuxTest("closes its tmux session when the command exits", async () => {
		let shutdown: (() => Promise<void>) | undefined;
		const tools = new Map<string, any>();
		bgBashExtension({
			on(event: string, handler: () => Promise<void>) {
				bindTestSession(event, handler);
				if (event === "session_shutdown") shutdown = handler;
			},
			registerCommand() {},
			registerTool(tool: any) { tools.set(tool.name, tool); },
		} as any);

		const started = await tools.get("bash").execute(
			"tmux-auto-close",
			{ command: "sleep 0.2; printf 'done\\n'", timeout: 0.1 },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		const job = started.details.job as { id: string; tmuxSession: string };

		try {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (testTmux(["has-session", "-t", job.tmuxSession]).exitCode !== 0) break;
				await Bun.sleep(25);
			}

			expect(testTmux(["has-session", "-t", job.tmuxSession]).exitCode).not.toBe(0);
			const output = await tools.get("bg_process").execute("tmux-output", { action: "output", id: job.id });
			expect(output.content[0].text).toContain("done");
			expect(output.details.jobs[0]).toMatchObject({ status: "exited", exitCode: 0 });
		} finally {
			testTmux(["kill-session", "-t", job.tmuxSession]);
			const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
			rmSync(join(cacheHome, "pi", "bg-bash", job.id), { recursive: true, force: true });
			await shutdown?.();
		}
	});

	tmuxTest("keeps refresh read-only when a tmux session disappears", async () => {
		let shutdown: (() => Promise<void>) | undefined;
		const tools = new Map<string, any>();
		bgBashExtension({
			on(event: string, handler: () => Promise<void>) {
				bindTestSession(event, handler);
				if (event === "session_shutdown") shutdown = handler;
			},
			registerCommand() {},
			registerTool(tool: any) { tools.set(tool.name, tool); },
		} as any);

		const started = await tools.get("bash").execute(
			"tmux-external-kill",
			{ command: "sleep 30", timeout: 0.1 },
			undefined,
			undefined,
			{ cwd: process.cwd() },
		);
		const job = started.details.job as { id: string; tmuxSession: string };
		const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
		const jobDir = join(cacheHome, "pi", "bg-bash", job.id);

		try {
			testTmux(["kill-session", "-t", job.tmuxSession]);
			const listed = await tools.get("bg_process").execute("tmux-list", { action: "list" });
			expect(listed.details.jobs.find((candidate: { id: string }) => candidate.id === job.id)).toMatchObject({
				status: "killed",
			});
			expect(existsSync(join(jobDir, "status"))).toBe(false);
		} finally {
			rmSync(jobDir, { recursive: true, force: true });
			await shutdown?.();
		}
	});
});
