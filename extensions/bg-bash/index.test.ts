import { afterAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { queryBackgroundJobs } from "./events.ts";
import { ManualScheduler } from "../test-scheduler.ts";

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
process.env.XDG_CACHE_HOME = testCacheHome;
const { backgroundJobScript, default: bgBashExtension } = await import("./index.ts");

afterAll(() => {
	rmSync(testCacheHome, { recursive: true, force: true });
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
	const scheduler = new ManualScheduler();
	const tools = new Map<string, any>();
	const listeners = new Map<string, Function>();
	const events = {
		on(name: string, handler: Function) { listeners.set(name, handler); return () => listeners.delete(name); },
		emit(name: string, value: unknown) { listeners.get(name)?.(value); },
	};
	bgBashExtension({
		events,
		on(event: string, handler: Function) { handlers.set(event, handler); },
		registerCommand() {},
		registerTool(tool: any) { tools.set(tool.name, tool); },
	} as any, { scheduler });
	const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => sessionId } };
	handlers.get("session_start")?.({}, ctx);
	return {
		tools,
		scheduler,
		query: (owner = sessionId) => queryBackgroundJobs({ events } as any, owner),
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

test("typed job query reports current ownership and unregisters on shutdown", async () => {
	const h = createHarness("mixture-query-owner");
	expect(h.query()).toMatchObject({ available: true, sessionId: "mixture-query-owner", jobs: [] });
	expect(h.query("other-owner").jobs).toEqual([]);
	await h.shutdown();
	expect(h.query().available).toBe(false);
});

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
			const timedResult = sleep.execute("timeout", { seconds: 0.01 });
			for (let index = 0; index < 3; index++) await Promise.resolve();
			await harness.scheduler.advanceBy(10);
			const timed = await timedResult;
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
		await Promise.resolve();
		await Promise.resolve();
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
		await Promise.resolve();
		await Promise.resolve();
		inputHandler?.({ streamingBehavior: "steer" });
		const steeringResult = await steeringSleep;
		expect(steeringResult.content[0].text).toContain("steering arrived");
		expect(steeringResult.details).toMatchObject({ wokeEarly: true, steering: true });

		const swarmSleep = tools.get("sleep").execute("sleep", { seconds: 30 }, undefined, undefined, {});
		await Promise.resolve();
		await Promise.resolve();
		eventHandlers.get("tripp:agent-swarm-activity")?.({ kind: "message", nodeId: "node_1" });
		const swarmResult = await swarmSleep;
		expect(swarmResult.content[0].text).toContain("agent-swarm activity arrived");
		expect(swarmResult.details).toMatchObject({ wokeEarly: true, agentSwarm: { kind: "message" } });
		await shutdown?.();
	});
});

describe("persistent command planning", () => {
	test("renders the grace period without exposing a persistence flag", async () => {
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

		const tool = tools.get("bash");
		const component = tool.renderCall({ command: "make release", timeout: 10 }, theme, {
			state: {}, isPartial: false, isError: false, lastComponent: undefined,
		});
		expect(tool.parameters.properties.tmux).toBeUndefined();
		expect(tool.parameters.properties.timeout.type).toBe("number");
		expect(component.render(100).map((line: string) => line.trim()).filter(Boolean)[0]).toBe("✓ $ make release (bg after 10s)");
		await shutdown?.();
	});

	test("builds a guarded zsh script with noninteractive pagers and exact command quoting", () => {
		const script = backgroundJobScript({
			shell: "/bin/zsh",
			gateFile: "/tmp/start gate",
			statusFile: "/tmp/status file",
			command: "printf '%s' \"$ZSH_VERSION\"; git --paginate branch",
		});
		expect(script).toContain("#!/bin/zsh\nset +e\nexport PAGER=cat GIT_PAGER=cat");
		expect(script).toContain("while [ ! -e '/tmp/start gate' ]");
		expect(script).toContain("/bin/zsh' -lc 'printf '");
		expect(script).toContain("mv -f '/tmp/status file.tmp' '/tmp/status file'");
		expect(script).toEndWith('exit "$__pi_bg_status"\n');
	});
});
