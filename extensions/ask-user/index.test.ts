import { describe, expect, mock, test } from "bun:test";

mock.module("typebox", () => ({
	Type: {
		Array: (schema: object, options: object = {}) => ({ type: "array", items: schema, ...options }),
		Boolean: (options: object = {}) => ({ type: "boolean", ...options }),
		Object: (properties: object) => ({ type: "object", properties }),
		Optional: (schema: object) => schema,
		String: (options: object = {}) => ({ type: "string", ...options }),
	},
}));

class MockEditor {
	onSubmit?: (value: string) => void;
	text = "";

	handleInput(data: string) {
		if (data === "enter") this.onSubmit?.(this.text);
		else this.text += data;
	}

	render() {
		return [this.text];
	}

	setText(text: string) {
		this.text = text;
	}
}

function wrap(text: string, width: number) {
	if (text.length <= width) return [text];
	const lines: string[] = [];
	let remaining = text;
	while (remaining.length > width) {
		let end = remaining.lastIndexOf(" ", width);
		if (end <= 0) end = width;
		lines.push(remaining.slice(0, end));
		remaining = remaining.slice(end).trimStart();
	}
	if (remaining) lines.push(remaining);
	return lines;
}

mock.module("@earendil-works/pi-tui", () => ({
	Editor: MockEditor,
	Key: {
		down: "down",
		enter: "enter",
		escape: "escape",
		left: "left",
		right: "right",
		space: "space",
		tab: "tab",
		up: "up",
		shift: (key: string) => `shift+${key}`,
	},
	matchesKey: (data: string, key: string) => data === key,
	Text: class {
		constructor(public text: string) {}
		render() { return this.text.split("\n"); }
		invalidate() {}
	},
	Box: class {
		clear() {}
		addChild() {}
		render() { return []; }
		invalidate() {}
	},
	Container: class {
		render() { return []; }
		invalidate() {}
	},
	truncateToWidth: (text: string, width: number) => text.slice(0, width),
	visibleWidth: (text: string) => text.length,
	wrapTextWithAnsi: wrap,
}));

const { default: askUserExtension } = await import("./index.ts");

const theme = {
	bg: (_role: string, text: string) => text,
	bold: (text: string) => text,
	fg: (_role: string, text: string) => text,
};

function registerTool() {
	let tool: any;
	askUserExtension({ registerTool(value: any) { tool = value; } } as any);
	return tool;
}

function interactiveContext(inputs: string[], rendered: string[][] = [], width = 80) {
	return {
		mode: "tui",
		ui: {
			custom(factory: any) {
				return new Promise((resolve) => {
					let component: any;
					const tui = {
						requestRender() {
							if (component) rendered.push(component.render(width));
						},
					};
					component = factory(tui, theme, {}, resolve);
					rendered.push(component.render(width));
					for (const input of inputs) component.handleInput(input);
				});
			},
		},
	};
}

const singleQuestion = {
	questions: [{
		id: "scope",
		header: "Scope",
		question: "Which implementation scope should I use?",
		type: "single",
		context: "The smaller change is easier to review.",
		options: [
			{ value: "minimal", label: "Minimal", description: "Smallest complete change", recommended: true },
			{ value: "full", label: "Full", description: "Broader redesign" },
		],
	}],
};

describe("ask_user tool", () => {
	test("exposes the bounded provider-compatible form schema", () => {
		const tool = registerTool();
		const questions = tool.parameters.properties.questions;
		const question = questions.items.properties;

		expect(Object.keys(tool.parameters.properties)).toEqual(["questions"]);
		expect(questions.minItems).toBe(1);
		expect(questions.maxItems).toBe(4);
		expect(question.type.enum).toEqual(["single", "multi", "text"]);
		expect(question.options.minItems).toBe(2);
		expect(question.options.maxItems).toBe(8);
		expect(Object.keys(question.options.items.properties)).toEqual([
			"value",
			"label",
			"description",
			"recommended",
		]);
		expect(tool.executionMode).toBe("sequential");
		expect(tool.renderShell).toBe("self");
	});

	test("renders context and recommendation without preselecting it", async () => {
		const rendered: string[][] = [];
		await registerTool().execute(
			"call",
			singleQuestion,
			undefined,
			undefined,
			interactiveContext(["escape"], rendered),
		);

		const initial = rendered[0].join("\n");
		expect(initial).toContain("Which implementation scope");
		expect(initial).toContain("easier to review");
		expect(initial).toContain("Minimal (recommended)");
		expect(initial).toContain("( ) Minimal");
	});

	test("collects single, multi, and text answers in one reviewed form", async () => {
		const result = await registerTool().execute(
			"call",
			{
				questions: [
					singleQuestion.questions[0],
					{
						id: "checks",
						header: "Checks",
						question: "Which checks should run?",
						type: "multi",
						options: [
							{ value: "tests", label: "Tests" },
							{ value: "lint", label: "Lint" },
						],
					},
					{
						id: "name",
						header: "Name",
						question: "What should it be called?",
						type: "text",
						placeholder: "Project name",
					},
				],
			},
			undefined,
			undefined,
			interactiveContext([
				"1",
				"space",
				"down",
				"space",
				"enter",
				"enter",
				"Apollo",
				"enter",
				"enter",
			]),
		);

		expect(result.details.cancelled).toBe(false);
		expect(result.details.answers).toEqual([
			{
				questionId: "scope",
				type: "single",
				selectedValues: ["minimal"],
				selectedLabels: ["Minimal"],
			},
			{
				questionId: "checks",
				type: "multi",
				selectedValues: ["tests", "lint"],
				selectedLabels: ["Tests", "Lint"],
			},
			{
				questionId: "name",
				type: "text",
				selectedValues: [],
				selectedLabels: [],
				customText: "Apollo",
			},
		]);
		expect(result.content[0].text).toContain('"scope"');
		expect(result.content[0].text).toContain('"selectedValues": [');
		expect(result.content[0].text).toContain('"Apollo"');
	});

	test("accepts a custom single-choice answer and reviews it", async () => {
		const result = await registerTool().execute(
			"call",
			singleQuestion,
			undefined,
			undefined,
			interactiveContext(["3", "A phased rollout", "enter", "enter"]),
		);

		expect(result.details.answers[0]).toEqual({
			questionId: "scope",
			type: "single",
			selectedValues: [],
			selectedLabels: [],
			customText: "A phased rollout",
		});
	});

	test("wraps long content within the available width", async () => {
		const rendered: string[][] = [];
		await registerTool().execute(
			"call",
			{
				questions: [{
					...singleQuestion.questions[0],
					question: "A deliberately long question that must wrap in a narrow terminal",
					options: [
						{
							value: "long",
							label: "A deliberately long option label",
							description: "A description long enough to wrap across several lines",
						},
						{ value: "short", label: "Short" },
					],
				}],
			},
			undefined,
			undefined,
			interactiveContext(["escape"], rendered, 32),
		);

		for (const line of rendered[0]) expect(line.length).toBeLessThanOrEqual(32);
		expect(rendered[0].join("\n")).toContain("across several");
		expect(rendered[0].join("\n")).toContain("lines");
	});

	test("reports dismissal without retaining partial answers", async () => {
		const result = await registerTool().execute(
			"call",
			singleQuestion,
			undefined,
			undefined,
			interactiveContext(["1", "escape"]),
		);

		expect(result.content[0].text).toContain("dismissed the form");
		expect(result.details).toMatchObject({ answers: [], cancelled: true });
	});

	test("distinguishes tool cancellation from user dismissal", async () => {
		const controller = new AbortController();
		const ctx = {
			mode: "tui",
			ui: {
				custom(factory: any) {
					return new Promise((resolve) => {
						factory({ requestRender() {} }, theme, {}, resolve);
						controller.abort();
					});
				},
			},
		};
		const result = await registerTool().execute("call", singleQuestion, controller.signal, undefined, ctx);

		expect(result.content[0].text).toBe("Cancelled");
	});

	test("returns a clear fallback outside the interactive TUI", async () => {
		const result = await registerTool().execute(
			"call",
			singleQuestion,
			undefined,
			undefined,
			{ mode: "print", ui: {} },
		);

		expect(result.content[0].text).toContain("No interactive TUI");
		expect(result.details.cancelled).toBe(true);
	});

	test("rejects duplicate ids and invalid type-specific options", async () => {
		const duplicate = {
			questions: [singleQuestion.questions[0], { ...singleQuestion.questions[0] }],
		};
		expect(registerTool().execute(
			"call",
			duplicate,
			undefined,
			undefined,
			interactiveContext([]),
		)).rejects.toThrow("id must be unique");

		expect(registerTool().execute(
			"call",
			{
				questions: [{
					id: "notes",
					header: "Notes",
					question: "Anything else?",
					type: "text",
					options: [{ value: "bad", label: "Invalid" }, { value: "also-bad", label: "Still invalid" }],
				}],
			},
			undefined,
			undefined,
			interactiveContext([]),
		)).rejects.toThrow("options must be omitted for text questions");
	});
});
