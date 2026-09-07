import { describe, expect, test } from "bun:test";
import computerUseToggle from "./index.ts";

const createHarness = () => {
	let activeTools = ["read", "computer_use"];
	let allTools = ["read", "computer_use"].map((name) => ({ name }));
	const handlers = new Map<string, (...args: any[]) => unknown>();
	let command: { handler(args: string, ctx: any): Promise<void> } | undefined;
	const notifications: string[] = [];
	const pi = {
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		getAllTools: () => [...allTools],
		on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
		registerCommand: (_name: string, definition: typeof command) => { command = definition; },
	};
	const ctx = { ui: { notify: (message: string) => notifications.push(message) } };

	computerUseToggle(pi as any);

	return {
		ctx,
		notifications,
		activeTools: () => activeTools,
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		setAllTools: (names: string[]) => { allTools = names.map((name) => ({ name })); },
		fire: (event: string) => handlers.get(event)?.({}, ctx),
		command: (args = "") => command!.handler(args, ctx),
	};
};

describe("computer-use-toggle", () => {
	test("hides Computer Use after startup discovery", () => {
		const harness = createHarness();
		harness.fire("session_start");
		harness.setActiveTools(["read", "computer_use"]);
		harness.fire("resources_discover");

		expect(harness.activeTools()).toEqual(["read"]);
	});

	test("toggles the composable Computer Use tool without changing unrelated tools", async () => {
		const harness = createHarness();
		harness.fire("resources_discover");

		await harness.command();
		expect(harness.activeTools()).toEqual(["read", "computer_use"]);

		await harness.command();
		expect(harness.activeTools()).toEqual(["read"]);
	});

	test("resets to off for a new session", async () => {
		const harness = createHarness();
		harness.fire("resources_discover");
		await harness.command("on");

		harness.fire("session_start");

		expect(harness.activeTools()).toEqual(["read"]);
	});

	test("keeps Computer Use hidden before a turn until enabled", () => {
		const harness = createHarness();
		harness.fire("resources_discover");
		harness.setActiveTools(["read", "computer_use"]);

		harness.fire("before_agent_start");

		expect(harness.activeTools()).toEqual(["read"]);
	});

	test("fails closed when the package tool is unavailable", async () => {
		const harness = createHarness();
		harness.fire("resources_discover");
		harness.setAllTools(["read"]);

		await harness.command("on");

		expect(harness.activeTools()).toEqual(["read"]);
		expect(harness.notifications.at(-1)).toContain("Computer Use unavailable");
	});
});
