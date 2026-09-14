import { describe, expect, test } from "bun:test";

const { default: thinkingSelector } = await import("./index.ts");

function harness(options: { model?: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }; mode?: string; current?: string } = {}) {
	let shortcut: any;
	let component: any;
	const selected: string[] = [];
	const notifications: string[] = [];
	let optionsShown: string[] = [];
	let choice: string | undefined;
	const pi = {
		registerShortcut: (_key: string, value: any) => {
			shortcut = value;
		},
		getThinkingLevel: () => options.current ?? "high",
		setThinkingLevel: (level: string) => selected.push(level),
	};
	const ctx = {
		model: options.model,
		mode: options.mode ?? "rpc",
		ui: {
			select: async (_title: string, values: string[]) => {
				optionsShown = values;
				return choice;
			},
			custom: (factory: (...args: any[]) => any) => new Promise(resolve => {
				component = factory(
					{ terminal: { rows: 20 }, requestRender: () => {} },
					{ fg: (_name: string, text: string) => text },
					undefined,
					resolve,
				);
			}),
			notify: (message: string) => notifications.push(message),
		},
	};
	thinkingSelector(pi as any);
	return {
		invoke: () => shortcut.handler(ctx),
		choose: (value?: string) => {
			choice = value;
		},
		confirmFocused: () => component.handleInput("\r"),
		cancelFocused: () => component.handleInput("\x1b"),
		options: () => optionsShown,
		selected,
		notifications,
		shortcut,
	};
}

describe("thinking selector shortcut", () => {
	test("marks the current level and applies the selected supported level", async () => {
		const run = harness({ model: { reasoning: true, thinkingLevelMap: { xhigh: null, max: "max" } } });
		run.choose("max");
		await run.invoke();
		expect(run.options()).toEqual(["off", "minimal", "low", "medium", "high (current)", "max"]);
		expect(run.selected).toEqual(["max"]);
		expect(run.shortcut.description).toBe("Select thinking level");
	});

	test.each([
		["first", "off", { reasoning: true }, "off"],
		["middle", "medium", { reasoning: true }, "medium"],
		["last", "max", { reasoning: true, thinkingLevelMap: { max: "max" } }, "max"],
		["unsupported", "xhigh", { reasoning: true, thinkingLevelMap: { xhigh: null, max: "max" } }, "off"],
	] as const)("opens the TUI picker on the current %s level", async (_position, current, model, expected) => {
		const run = harness({ mode: "tui", current, model });
		const invocation = run.invoke();
		run.confirmFocused();
		await invocation;
		expect(run.selected).toEqual([expected]);
	});

	test("cancels the TUI picker with the encoded Escape key", async () => {
		const run = harness({ mode: "tui", model: { reasoning: true } });
		const invocation = run.invoke();
		run.cancelFocused();
		await invocation;
		expect(run.selected).toEqual([]);
	});

	test("does nothing when cancelled", async () => {
		const run = harness({ model: { reasoning: true } });
		await run.invoke();
		expect(run.selected).toEqual([]);
	});

	test("warns when no model or thinking levels are available", async () => {
		for (const model of [undefined, { reasoning: false }]) {
			const run = harness({ model });
			await run.invoke();
			expect(run.notifications).toHaveLength(1);
			expect(run.selected).toEqual([]);
		}
	});
});
