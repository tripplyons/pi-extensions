import { beforeEach, describe, expect, mock, test } from "bun:test";

const canonicalModel = {
	id: "gpt-5.6-luna",
	name: "Luna",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

let fetchSignal: AbortSignal | undefined;
let fetchContext: any;
let fetchResult: unknown;
let fetchError: Error | undefined;

function usageSnapshot() {
	const now = Math.floor(Date.now() / 1000);
	return {
		planType: "pro",
		resetCredits: { availableCount: 2, credits: [], raw: {} },
		limits: [
			{
				limitId: "codex",
				primary: { usedPercent: 20, windowMinutes: 300, resetsAt: now + 300 },
				secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: now + 600 },
			},
			{
				limitId: "gpt-5.3-codex-spark",
				limitName: "Codex Spark",
				primary: { usedPercent: 99, resetsAt: now + 300 },
			},
			{
				limitId: "luna-reserve",
				limitName: "Luna Reserve",
				primary: { usedPercent: 1, resetsAt: now + 300 },
			},
		],
		raw: {},
	};
}

mock.module("@howaboua/pi-codex-conversion/dist/codex-usage/client.js", () => ({
	fetchCodexUsage: async (ctx: { signal: AbortSignal }) => {
		fetchSignal = ctx.signal;
		fetchContext = ctx;
		if (fetchError) throw fetchError;
		return fetchResult;
	},
}));

const { default: usageExtension } = await import("./index.ts");

function harness(options: { provider?: string; mode?: string; hasUI?: boolean; canonicalModel?: boolean } = {}) {
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
		model: { provider: options.provider ?? "anthropic", id: "active" },
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		modelRegistry: {
			find: (provider: string, id: string) => options.canonicalModel === false || provider !== "openai-codex" || id !== "gpt-5.6-luna" ? undefined : canonicalModel,
		},
		ui: {
			notify: (text: string, type: string) => notifications.push({ text, type }),
			custom: async (factory: (...args: any[]) => any) => {
				overlay = factory(undefined, {
					bg: (name: string, text: string) => `<${name}>${text}`,
					fg: (_name: string, text: string) => text,
				}, undefined, () => {
					dismissed = true;
				});
			},
		},
	};
	usageExtension(pi as any);
	return { commands, handlers, notifications, ctx, overlay: () => overlay, dismissed: () => dismissed };
}

beforeEach(() => {
	fetchSignal = undefined;
	fetchContext = undefined;
	fetchResult = usageSnapshot();
	fetchError = undefined;
});

describe("usage command", () => {
	test("replaces /usage with /codex-usage and uses canonical auth across providers", async () => {
		const run = harness({ provider: "anthropic" });
		expect(run.commands.has("usage")).toBeFalse();
		await run.commands.get("codex-usage").handler("", run.ctx);

		expect(run.notifications).toEqual([]);
		expect(fetchContext.model).toBe(canonicalModel);
		expect(run.overlay().render(80).join("\n")).toContain("5h: 80% left");
		expect(run.overlay().render(80).join("\n")).toContain("weekly: 60% left");
		expect(run.overlay().render(80).join("\n")).toContain("<customMessageBg>");
		expect(run.overlay().render(80).join("\n")).not.toContain("Spark");
		expect(run.overlay().render(80).join("\n")).not.toContain("pro");
		expect(run.overlay().render(80).join("\n")).not.toContain("credits");
		run.overlay().handleInput("q");
		expect(run.dismissed()).toBeTrue();
	});

	test("uses the same concise popup text as a notification outside the TUI", async () => {
		const run = harness({ mode: "rpc" });
		await run.commands.get("codex-usage").handler("", run.ctx);
		expect(run.notifications).toHaveLength(1);
		expect(run.notifications[0]?.text).toContain("Codex usage\n5h: 80% left · resets in ~5m\nweekly: 60% left · resets in ~10m");
		expect(run.notifications[0]?.text).not.toContain("Spark");
		expect(run.notifications[0]?.text).not.toContain("pro");
		expect(run.notifications[0]?.text).not.toContain("credits");
	});

	test("surfaces missing canonical model/auth explicitly", async () => {
		const run = harness({ canonicalModel: false });
		await run.commands.get("codex-usage").handler("", run.ctx);
		expect(fetchSignal).toBeUndefined();
		expect(run.notifications).toEqual([
			{ text: "Canonical OpenAI Codex model is unavailable.", type: "error" },
		]);

		fetchError = new Error("Canonical OpenAI Codex subscription auth is required.");
		const authenticated = harness();
		await authenticated.commands.get("codex-usage").handler("", authenticated.ctx);
		expect(authenticated.notifications).toEqual([
			{ text: "Canonical OpenAI Codex subscription auth is required.", type: "error" },
		]);
	});

	test("aborts an outstanding request on shutdown", async () => {
		fetchResult = new Promise(() => {});
		const run = harness();
		void run.commands.get("codex-usage").handler("", run.ctx);
		await Bun.sleep(0);
		expect(fetchSignal?.aborted).toBeFalse();
		await run.handlers.get("session_shutdown")?.({}, run.ctx);
		expect(fetchSignal?.aborted).toBeTrue();
	});

	test("aborts a superseded request", async () => {
		fetchResult = new Promise(() => {});
		const run = harness();
		void run.commands.get("codex-usage").handler("", run.ctx);
		await Bun.sleep(0);
		const superseded = fetchSignal;
		void run.commands.get("codex-usage").handler("", run.ctx);
		await Bun.sleep(0);
		expect(superseded?.aborted).toBeTrue();
		await run.handlers.get("session_shutdown")?.({}, run.ctx);
	});
});
