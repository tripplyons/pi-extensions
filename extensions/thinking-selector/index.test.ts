import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "bun:test";

initTheme("dark");
const { default: thinkingSelector } = await import("./index.ts");

const CUSTOM_TEXT_FG = "\x1b[38;5;111m";
const CUSTOM_BG = "\x1b[48;5;234m";
const popupTheme = {
	fg: (name: string, text: string) => `${name === "customMessageText" ? CUSTOM_TEXT_FG : "\x1b[38;5;222m"}${text}\x1b[39m`,
	bg: (name: string, text: string) => `${name === "customMessageBg" ? CUSTOM_BG : "\x1b[48;5;235m"}${text}\x1b[49m`,
};

function harness(options: { model?: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }; mode?: string; current?: string; rows?: number } = {}) {
	let shortcut: any;
	let shortcutKey: string;
	let component: any;
	let customOptions: any;
	const selected: string[] = [];
	const notifications: string[] = [];
	let optionsShown: string[] = [];
	let choice: string | undefined;
	const pi = {
		registerShortcut: (key: string, value: any) => {
			shortcutKey = key;
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
			custom: (factory: (...args: any[]) => any, uiOptions: any) => new Promise(resolve => {
				customOptions = uiOptions;
				component = factory(
					{ terminal: { rows: options.rows ?? 20 }, requestRender: () => {} },
					popupTheme,
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
		press: (key: string) => component.handleInput(key),
		confirmFocused: () => component.handleInput("\r"),
		cancelFocused: () => component.handleInput("\x1b"),
		render: (width = 80) => component.render(width),
		options: () => optionsShown,
		customOptions: () => customOptions,
		shortcutKey,
		selected,
		notifications,
		shortcut,
	};
}

function plain(lines: string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line));
}

describe("thinking selector shortcut", () => {
	test("marks the current level and applies the selected supported level", async () => {
		const run = harness({ model: { reasoning: true, thinkingLevelMap: { xhigh: null, max: "max" } } });
		run.choose("max");
		await run.invoke();
		expect(run.options()).toEqual(["off", "minimal", "low", "medium", "high (current)", "max"]);
		expect(run.selected).toEqual(["max"]);
		expect(run.shortcut.description).toBe("Select thinking level");
		expect(run.shortcutKey).toBe("ctrl+t");
	});

	test("renders a usage-style popup with padded normal text and selected styling", async () => {
		const run = harness({ mode: "tui", current: "medium", model: { reasoning: true } });
		const invocation = run.invoke();
		const rendered = run.render(40);
		const stripped = plain(rendered);

		expect(run.customOptions()).toEqual({
			overlay: true,
			overlayOptions: { width: "70%", maxHeight: "70%", anchor: "center" },
		});
		expect(rendered).toHaveLength(8);
		expect(rendered.every((line: string) => visibleWidth(line) === 40)).toBeTrue();
		expect(rendered.every((line: string) => line.includes(CUSTOM_BG))).toBeTrue();
		expect(stripped[0]).toBe(" ".repeat(40));
		expect(stripped[1]).toBe(` Thinking level${" ".repeat(25)}`);
		expect(rendered[1]).toContain(CUSTOM_TEXT_FG);
		expect(stripped.at(-1)).toBe(" ".repeat(40));

		const selectedLine = rendered.find((line: string) => plain([line])[0]?.includes("→ medium (current)"));
		const normalLine = rendered.find((line: string) => plain([line])[0]?.includes("  off"));
		expect(selectedLine).toBeDefined();
		expect(selectedLine).not.toContain(CUSTOM_TEXT_FG);
		expect(normalLine).toContain(CUSTOM_TEXT_FG);
		expect(plain([normalLine])[0]).toStartWith("   off");

		run.cancelFocused();
		await invocation;
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

	test.each([
		["j", "high"],
		["k", "low"],
	] as const)("moves with %s in the TUI picker", async (key, expected) => {
		const run = harness({ mode: "tui", current: "medium", model: { reasoning: true } });
		const invocation = run.invoke();
		run.press(key);
		run.confirmFocused();
		await invocation;
		expect(run.selected).toEqual([expected]);
	});

	test.each([
		["up arrow", "\x1b[A", "low"],
		["down arrow", "\x1b[B", "high"],
	] as const)("moves with %s in the TUI picker", async (_name, key, expected) => {
		const run = harness({ mode: "tui", current: "medium", model: { reasoning: true } });
		const invocation = run.invoke();
		run.press(key);
		run.confirmFocused();
		await invocation;
		expect(run.selected).toEqual([expected]);
	});

	test("keeps the selected last level visible in a short popup", async () => {
		const run = harness({
			mode: "tui",
			rows: 10,
			current: "max",
			model: { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
		});
		const invocation = run.invoke();
		const render = () => run.render(60);
		const initial = plain(render());

		expect(render()).toHaveLength(7);
		expect(render().every((line: string) => visibleWidth(line) <= 60)).toBeTrue();
		expect(initial.some((line) => line.includes(" → max (current)"))).toBeTrue();
		expect(initial.some((line) => line.includes("(7/7)"))).toBeTrue();

		const narrowRendered = run.render(16);
		expect(narrowRendered.every((line: string) => visibleWidth(line) <= 16)).toBeTrue();
		expect(plain(narrowRendered).some((line) => line.includes("→"))).toBeTrue();

		run.press("k");
		expect(plain(render()).some((line) => line.includes(" → xhigh"))).toBeTrue();
		expect(render()).toHaveLength(7);

		run.press("\x1b[B");
		expect(plain(render()).some((line) => line.includes(" → max (current)"))).toBeTrue();
		expect(render()).toHaveLength(7);

		run.confirmFocused();
		await invocation;
		expect(run.selected).toEqual(["max"]);
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
