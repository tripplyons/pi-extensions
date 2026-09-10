import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[], options: object) => ({ type: "string", enum: [...values], ...options }),
}));
mock.module("typebox", () => ({
	Type: {
		Integer: (options: object) => ({ type: "integer", ...options }),
		Object: (properties: object) => ({ type: "object", properties }),
		Optional: (schema: object) => schema,
		String: (options: object = {}) => ({ type: "string", ...options }),
	},
}));
const { default: goalExtension } = await import("./index.ts");

type Handler = (...args: any[]) => unknown;

const createHarness = (storedGoal = true, status = "active") => {
	const startedAt = Date.now() - 5_500;
	const entries: any[] = storedGoal ? [
		{
			type: "custom",
			customType: "goal-state",
			data: { objective: "Finish the task", status, activeSince: status === "active" ? startedAt : null },
		},
	] : [];
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sentMessages: any[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	let activeTools: string[] = [];
	let idle = true;

	const pi = {
		on(event: string, handler: Handler) {
			const previous = handlers.get(event);
			handlers.set(event, previous
				? async (...args: any[]) => {
					await previous(...args);
					return handler(...args);
				}
				: handler);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
			activeTools.push(tool.name);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(message: unknown, options: unknown) {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
	};

	const ctx = {
		cwd: "/tmp/project",
		mode: "tui",
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
			getSessionId: () => "goal-session-1",
			getEntries: () => entries,
			getBranch: () => entries,
		},
		ui: {
			theme: { fg: (_role: string, text: string) => text },
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value);
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
		isIdle: () => idle,
		hasPendingMessages: () => false,
	};

	goalExtension(pi as any);

	return {
		ctx,
		entries,
		handlers,
		tools,
		commands,
		sentMessages,
		notifications,
		statuses,
		activeTools: () => [...activeTools],
		setIdle(value: boolean) {
			idle = value;
		},
	};
};

const latestGoal = (entries: any[]) => entries.findLast((entry) => entry.customType === "goal-state")?.data;

describe("goal lifecycle", () => {
	test("shows only active goals in the footer", async () => {
		const inactive = createHarness(false);
		await inactive.handlers.get("session_start")?.({}, inactive.ctx);
		expect(inactive.statuses.at(-1)).toBeUndefined();

		const active = createHarness();
		await active.handlers.get("session_start")?.({}, active.ctx);
		expect(active.statuses.at(-1)).toBe("goal");

		for (const status of ["paused", "blocked", "complete", "budget_limited", "usage_limited"]) {
			const restored = createHarness(true, status);
			await restored.handlers.get("session_start")?.({}, restored.ctx);
			expect(restored.statuses.at(-1)).toBeUndefined();
		}
	});

	test("defers a restored goal until session startup has returned", async () => {
		const harness = createHarness();

		await harness.handlers.get("session_start")?.({}, harness.ctx);
		expect(harness.sentMessages).toHaveLength(0);

		await Bun.sleep(5);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0].message.customType).toBe("goal-continuation");
	});

	test("does not queue a continuation while another agent turn is active", async () => {
		const harness = createHarness();
		harness.setIdle(false);

		await harness.handlers.get("session_start")?.({}, harness.ctx);
		await Bun.sleep(5);
		expect(harness.sentMessages).toHaveLength(0);

		harness.setIdle(true);
		await harness.handlers.get("agent_settled")?.({}, harness.ctx);
		expect(harness.sentMessages).toHaveLength(0);
		await Bun.sleep(5);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0].message.customType).toBe("goal-continuation");
	});

	test("continues an active goal only after the agent settles", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		harness.sentMessages.length = 0;

		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await harness.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, harness.ctx);

		expect(latestGoal(harness.entries).status).toBe("active");
		expect(harness.sentMessages).toHaveLength(0);

		await harness.handlers.get("agent_settled")?.({}, harness.ctx);
		await harness.handlers.get("agent_settled")?.({}, harness.ctx);
		expect(harness.sentMessages).toHaveLength(0);
		await Bun.sleep(5);

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0].message.customType).toBe("goal-continuation");
	});

	test("pauses only after the agent reports an interrupted run", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		harness.sentMessages.length = 0;

		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await harness.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "aborted" }] }, harness.ctx);
		await harness.handlers.get("agent_settled")?.({}, harness.ctx);
		await Bun.sleep(5);

		expect(latestGoal(harness.entries).status).toBe("paused");
		expect(harness.sentMessages).toHaveLength(0);
	});

	test("holds a goal continuation until Codex compaction commits and the agent settles", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		harness.sentMessages.length = 0;
		await harness.handlers.get("session_before_compact")?.({}, harness.ctx);
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await harness.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "aborted" }] }, harness.ctx);
		await harness.handlers.get("agent_settled")?.({}, harness.ctx);

		expect(latestGoal(harness.entries).status).toBe("active");
		expect(harness.sentMessages).toHaveLength(0);

		await harness.handlers.get("session_compact")?.({}, harness.ctx);
		expect(harness.sentMessages).toHaveLength(0);

		await harness.handlers.get("agent_settled")?.({}, harness.ctx);
		expect(harness.sentMessages).toHaveLength(0);
		await Bun.sleep(5);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0].message.customType).toBe("goal-continuation");
	});

	test("pauses an active goal when Codex compaction fails", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		harness.sentMessages.length = 0;
		await harness.handlers.get("session_before_compact")?.({}, harness.ctx);
		await harness.handlers.get("session_compact_failed")?.(
			{ errorMessage: "request failed" },
			harness.ctx,
		);

		expect(latestGoal(harness.entries).status).toBe("paused");
		expect(harness.sentMessages).toHaveLength(0);
		expect(harness.notifications.at(-1)).toContain("compaction failed");
	});

	test("restores an interrupted goal after successful compaction", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		harness.sentMessages.length = 0;

		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await harness.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "aborted" }] }, harness.ctx);
		await harness.handlers.get("session_compact")?.({}, harness.ctx);

		expect(latestGoal(harness.entries).status).toBe("active");
		expect(harness.sentMessages).toHaveLength(0);
	});

	test("leaves an interrupted goal paused when compaction fails", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);

		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await harness.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "aborted" }] }, harness.ctx);
		await harness.handlers.get("session_compact_failed")?.({}, harness.ctx);
		await harness.handlers.get("session_compact")?.({}, harness.ctx);

		expect(latestGoal(harness.entries).status).toBe("paused");
	});

	test("does not restore an interrupted goal after another agent run starts", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);

		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await harness.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "aborted" }] }, harness.ctx);
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await harness.handlers.get("session_compact")?.({}, harness.ctx);

		expect(latestGoal(harness.entries).status).toBe("paused");
	});

	test("reports elapsed time and finalized message tokens before agent_end", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		const message = {
			role: "assistant",
			stopReason: "toolUse",
			usage: { totalTokens: 321 },
		};

		await harness.handlers.get("message_end")?.({ message }, harness.ctx);
		await harness.commands.get("goal").handler("", harness.ctx);

		const status = harness.notifications.at(-1);
		expect(status).not.toContain("Time used: 0s");
		expect(status).toContain("Tokens used: 321");

		await harness.handlers.get("agent_end")?.({ messages: [message] }, harness.ctx);
		expect(latestGoal(harness.entries).tokensUsed).toBe(321);
	});

	test("terminates the agent run when the goal is complete or blocked", async () => {
		for (const status of ["complete", "blocked"] as const) {
			const harness = createHarness();
			await harness.handlers.get("session_start")?.({}, harness.ctx);

			const result = await harness.tools.get("update_goal").execute("call", { status }, undefined, undefined, harness.ctx);

			expect(result.terminate).toBe(true);
			expect(latestGoal(harness.entries).status).toBe(status);
			expect(harness.statuses.at(-1)).toBeUndefined();
		}
	});

	test("exposes only complete and blocked statuses to the model", () => {
		const harness = createHarness();
		const schema = harness.tools.get("update_goal").parameters.properties.status;

		expect(schema.enum).toEqual(["complete", "blocked"]);
	});

	test("registers every goal tool directly", () => {
		const harness = createHarness();

		expect([...harness.tools.keys()]).toEqual(["get_goal", "create_goal", "update_goal"]);
	});

	test("throws failed goal operations", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);

		await expect(
			harness.tools.get("create_goal").execute(
				"call",
				{ objective: "Replacement" },
				undefined,
				undefined,
				harness.ctx,
			),
		).rejects.toThrow("unfinished goal");
	});

});
