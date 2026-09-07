import { describe, expect, test } from "bun:test";

import codexFastModeExtension from "./index.ts";

type ShortcutHandler = (ctx: any) => Promise<void>;

const createHarness = ({ modelAvailable = true, modelSetSucceeds = true } = {}) => {
	const previousModel = { provider: "openrouter", id: "previous-model" };
	const lunaModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
	const entries: Array<{ customType: string; data: { enabled: boolean } }> = [];
	const selectedModels: unknown[] = [];
	const thinkingLevels: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sessionEntries: unknown[] = [];
	let thinkingLevel = "high";
	let shortcut: ShortcutHandler | undefined;

	const pi = {
		appendEntry(customType: string, data: { enabled: boolean }) {
			entries.push({ customType, data });
		},
		getThinkingLevel: () => thinkingLevel,
		on(name: string, handler: (event?: unknown, ctx?: unknown) => unknown) { handlers.set(name, handler); },
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, options); },
		registerShortcut(key: string, options: { handler: ShortcutHandler }) {
			expect(key).toBe("ctrl+f");
			shortcut = options.handler;
		},
		async setModel(model: unknown) {
			selectedModels.push(model);
			return modelSetSucceeds;
		},
		setThinkingLevel(level: string) {
			thinkingLevel = level;
			thinkingLevels.push(level);
		},
	};
	const ctx = {
		model: previousModel,
		modelRegistry: { find: () => (modelAvailable ? lunaModel : undefined) },
		sessionManager: { getEntries: () => sessionEntries },
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setStatus() {},
			theme: { fg: (_role: string, text: string) => text },
		},
	};

	codexFastModeExtension(pi as any);

	return { ctx, entries, handlers, commands, notifications, selectedModels, sessionEntries, shortcut: () => shortcut!(ctx), thinkingLevels, previousModel, lunaModel };
};

describe("Codex fast model shortcut", () => {
	test("inherits the swarm fast-mode state when the child has no saved state", async () => {
		const previous = process.env.PI_SWARM_CODEX_FAST_MODE;
		process.env.PI_SWARM_CODEX_FAST_MODE = "on";
		const harness = createHarness();
		try {
			await harness.handlers.get("session_start")?.({}, harness.ctx);
			await harness.commands.get("fast")?.handler("toggle", harness.ctx);
			expect(harness.entries.at(-1)?.data.enabled).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PI_SWARM_CODEX_FAST_MODE;
			else process.env.PI_SWARM_CODEX_FAST_MODE = previous;
		}
	});

	test("prefers saved state over the inherited swarm value", async () => {
		const previous = process.env.PI_SWARM_CODEX_FAST_MODE;
		process.env.PI_SWARM_CODEX_FAST_MODE = "on";
		const harness = createHarness();
		harness.sessionEntries.push({ type: "custom", customType: "codex-fast-mode-state", data: { enabled: false } });
		try {
			await harness.handlers.get("session_start")?.({}, harness.ctx);
			await harness.commands.get("fast")?.handler("toggle", harness.ctx);
			expect(harness.entries.at(-1)?.data.enabled).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_SWARM_CODEX_FAST_MODE;
			else process.env.PI_SWARM_CODEX_FAST_MODE = previous;
		}
	});

	test("switches to Luna high and restores the previous settings on the next press", async () => {
		const harness = createHarness();

		await harness.shortcut();
		expect(harness.selectedModels).toEqual([harness.lunaModel]);
		expect(harness.thinkingLevels).toEqual(["high"]);
		expect(harness.entries.at(-1)?.data.enabled).toBe(true);

		await harness.shortcut();
		expect(harness.selectedModels).toEqual([harness.lunaModel, harness.previousModel]);
		expect(harness.thinkingLevels).toEqual(["high", "high"]);
		expect(harness.entries.at(-1)?.data.enabled).toBe(false);
	});

	test("does not alter settings when Luna cannot be selected", async () => {
		const harness = createHarness({ modelSetSucceeds: false });

		await harness.shortcut();
		expect(harness.thinkingLevels).toEqual([]);
		expect(harness.entries).toEqual([]);
		expect(harness.notifications.at(-1)?.level).toBe("error");
	});
});
