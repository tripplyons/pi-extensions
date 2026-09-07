import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[]) => ({ type: "string", enum: [...values] }),
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
	DEFAULT_MAX_BYTES: 50_000,
	DEFAULT_MAX_LINES: 2_000,
	formatSize: (value: number) => String(value),
	truncateHead: (content: string) => ({
		content,
		truncated: false,
		outputBytes: content.length,
		outputLines: content.split("\n").length,
		totalBytes: content.length,
		totalLines: content.split("\n").length,
	}),
	withFileMutationQueue: (_path: string, operation: () => unknown) => operation(),
}));
mock.module("@earendil-works/pi-tui", () => ({
	Text: class {
		constructor(public text: string) {}
	},
	truncateToWidth: (text: string) => text,
}));
mock.module("typebox", () => ({
	Type: {
		Integer: (options: object) => ({ type: "integer", ...options }),
		Number: (options: object) => ({ type: "number", ...options }),
		Object: (properties: object) => ({ type: "object", properties }),
		Optional: (schema: object) => schema,
		String: (options: object = {}) => ({ type: "string", ...options }),
	},
}));
mock.module("../tool-status-style/style.ts", () => ({
	withStatusCard: (definition: unknown) => definition,
}));

const { default: webSearchAndExtractExtension } = await import("./index.ts");

type Handler = (...args: any[]) => unknown;

const createHarness = (entries: unknown[] = []) => {
	const commands = new Map<string, Handler>();
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, any>();
	const statuses = new Map<string, string>();
	const notifications: string[] = [];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const execCalls: string[][] = [];
	const pi = {
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({ customType, data });
		},
		exec: async (_command: string, args: string[]) => {
			execCalls.push(args);
			const type = args[0];
			return {
				code: 0,
				killed: false,
				stderr: "",
				stdout: type === "search"
					? "Provider: ddgs\nQuery: test\n\nresults\n"
					: "Provider: camoufox\nURL: https://example.com\n\ncontent\n",
			};
		},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command.handler);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	};
	const ctx = {
		sessionManager: { getEntries: () => entries },
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (key: string, value: string) => statuses.set(key, value),
			theme: { fg: (_role: string, text: string) => text },
		},
	};

	webSearchAndExtractExtension(pi as any);
	return { appendedEntries, commands, ctx, execCalls, handlers, notifications, statuses, tools };
};

const execute = (tool: any, params: object, ctx: object) =>
	tool.execute("call", params, undefined, undefined, ctx);

describe("local web mode", () => {
	test("toggles per-session state and routes auto providers locally", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		expect(harness.statuses.get("local")).toBe("local off");

		await harness.commands.get("local")?.("on", harness.ctx);
		expect(harness.statuses.get("local")).toBe("local on");
		expect(harness.appendedEntries).toEqual([
			{ customType: "web-search-local-mode-state", data: { enabled: true } },
		]);

		const searchResult = await execute(harness.tools.get("web_search"), { query: "test" }, harness.ctx);
		const extractResult = await execute(harness.tools.get("web_extract"), { url: "https://example.com" }, harness.ctx);
		expect(searchResult.details.provider).toBe("ddgs");
		expect(extractResult.details.provider).toBe("camoufox");
		expect(harness.execCalls[0]?.[0]).toBe("search");
		expect(harness.execCalls[1]).toContain("auto");
	});

	test("rejects explicit Codex requests and tells the agent local mode is active", async () => {
		const harness = createHarness([
			{ type: "custom", customType: "web-search-local-mode-state", data: { enabled: true } },
		]);
		await harness.handlers.get("session_start")?.({}, harness.ctx);

		await expect(execute(harness.tools.get("web_search"), { query: "test", provider: "codex" }, harness.ctx))
			.rejects.toThrow("disabled by /local");
		await expect(execute(harness.tools.get("web_extract"), { url: "https://example.com", provider: "codex" }, harness.ctx))
			.rejects.toThrow("disabled by /local");
		expect(harness.execCalls).toHaveLength(0);

		const result = await harness.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, harness.ctx) as any;
		expect(result.systemPrompt).toContain("Local web mode is enabled");
		expect(result.systemPrompt).toContain("must not use provider codex");
	});
});
