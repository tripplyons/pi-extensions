import { describe, expect, mock, test } from "bun:test";

let fetchSignal: AbortSignal | undefined;
let fetchResult: unknown = { planType: "pro", limits: [] };
let fetchError: Error | undefined;

mock.module("@howaboua/pi-codex-conversion/dist/codex-usage/client.js", () => ({
	fetchCodexUsage: async (ctx: { signal: AbortSignal }) => {
		fetchSignal = ctx.signal;
		if (fetchError) throw fetchError;
		return fetchResult;
	},
}));
mock.module("@howaboua/pi-codex-conversion/dist/codex-usage/format.js", () => ({
	formatCodexUsage: () => "Codex usage\n5h: 80% left\nweekly: 60% left",
}));

const { default: usageExtension } = await import("./index.ts");

function harness(options: { provider?: string; mode?: string; hasUI?: boolean } = {}) {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, any>();
	const notifications: Array<{ text: string; type: string }> = [];
	let overlay: any;
	let dismissed = false;
	const pi = {
		on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	};
	const ctx = {
		model: { provider: options.provider ?? "openai-codex" },
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (text: string, type: string) => notifications.push({ text, type }),
			custom: async (factory: (...args: any[]) => any) => {
				overlay = factory(undefined, undefined, undefined, () => {
					dismissed = true;
				});
			},
		},
	};
	usageExtension(pi as any);
	return { commands, handlers, notifications, ctx, overlay: () => overlay, dismissed: () => dismissed };
}

describe("usage command", () => {
	test("shows Codex usage in a dismissible overlay", async () => {
		const run = harness();
		await run.commands.get("usage").handler("", run.ctx);

		expect(run.notifications).toEqual([]);
		expect(run.overlay().render(80).join("\n")).toContain("weekly: 60% left");
		run.overlay().handleInput("q");
		expect(run.dismissed()).toBeTrue();
	});

	test("uses a notification outside the TUI", async () => {
		const run = harness({ mode: "rpc" });
		await run.commands.get("usage").handler("", run.ctx);
		expect(run.notifications).toEqual([{ text: "Codex usage\n5h: 80% left\nweekly: 60% left", type: "info" }]);
	});

	test("rejects non-Codex models without fetching", async () => {
		fetchSignal = undefined;
		const run = harness({ provider: "anthropic" });
		await run.commands.get("usage").handler("", run.ctx);
		expect(fetchSignal).toBeUndefined();
		expect(run.notifications[0]?.type).toBe("warning");
	});

	test("surfaces authentication and API failures", async () => {
		fetchError = new Error("Canonical OpenAI Codex subscription auth is required.");
		const run = harness();
		await run.commands.get("usage").handler("", run.ctx);
		expect(run.notifications).toEqual([
			{ text: "Canonical OpenAI Codex subscription auth is required.", type: "error" },
		]);
		fetchError = undefined;
	});

	test("aborts an outstanding request on shutdown", async () => {
		fetchResult = new Promise(() => {});
		const run = harness();
		void run.commands.get("usage").handler("", run.ctx);
		await Bun.sleep(0);
		expect(fetchSignal?.aborted).toBeFalse();
		await run.handlers.get("session_shutdown")?.({}, run.ctx);
		expect(fetchSignal?.aborted).toBeTrue();
		fetchResult = { planType: "pro", limits: [] };
	});

	test("aborts a superseded request", async () => {
		fetchResult = new Promise(() => {});
		const run = harness();
		void run.commands.get("usage").handler("", run.ctx);
		await Bun.sleep(0);
		const superseded = fetchSignal;
		void run.commands.get("usage").handler("", run.ctx);
		await Bun.sleep(0);
		expect(superseded?.aborted).toBeTrue();
		await run.handlers.get("session_shutdown")?.({}, run.ctx);
		fetchResult = { planType: "pro", limits: [] };
	});
});
