import { describe, expect, test } from "bun:test";

const { default: thinkingSelector } = await import("./index.ts");

function harness(model?: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }) {
	let shortcut: any;
	const selected: string[] = [];
	const notifications: string[] = [];
	let options: string[] = [];
	let choice: string | undefined;
	const pi = {
		registerShortcut: (_key: string, value: any) => {
			shortcut = value;
		},
		getThinkingLevel: () => "high",
		setThinkingLevel: (level: string) => selected.push(level),
	};
	const ctx = {
		model,
		ui: {
			select: async (_title: string, values: string[]) => {
				options = values;
				return choice;
			},
			notify: (message: string) => notifications.push(message),
		},
	};
	thinkingSelector(pi as any);
	return {
		invoke: () => shortcut.handler(ctx),
		choose: (value?: string) => {
			choice = value;
		},
		options: () => options,
		selected,
		notifications,
		shortcut,
	};
}

describe("thinking selector shortcut", () => {
	test("marks the current level and applies the selected supported level", async () => {
		const run = harness({ reasoning: true, thinkingLevelMap: { xhigh: null, max: "max" } });
		run.choose("max");
		await run.invoke();
		expect(run.options()).toEqual(["off", "minimal", "low", "medium", "high (current)", "max"]);
		expect(run.selected).toEqual(["max"]);
		expect(run.shortcut.description).toBe("Select thinking level");
	});

	test("does nothing when cancelled", async () => {
		const run = harness({ reasoning: true });
		await run.invoke();
		expect(run.selected).toEqual([]);
	});

	test("warns when no model or thinking levels are available", async () => {
		for (const model of [undefined, { reasoning: false }]) {
			const run = harness(model);
			await run.invoke();
			expect(run.notifications).toHaveLength(1);
			expect(run.selected).toEqual([]);
		}
	});
});
