import { describe, expect, mock, test } from "bun:test";

class MockBox {
	children: any[] = [];
	background?: (text: string) => string;

	addChild(child: any) { this.children.push(child); }
	clear() { this.children = []; }
	invalidate() {}
	setBgFn(background: (text: string) => string) { this.background = background; }
	render(width: number) {
		return this.children
			.flatMap((child) => child.render(width))
			.map((line) => this.background?.(line) ?? line);
	}
}

class MockText {
	constructor(public text: string) {}
	invalidate() {}
	render() { return this.text.split("\n"); }
	setText(text: string) { this.text = text; }
}

mock.module("@earendil-works/pi-tui", () => ({
	Box: MockBox,
	Container: class {
		invalidate() {}
		render() { return []; }
	},
	Text: MockText,
	truncateToWidth: (text: string, width: number) => text.slice(0, width),
	visibleWidth: (text: string) => text.length,
}));

const { installGlobalStatusCards, installSpecialToolRenderer, returnedErrorPatch, withStatusCard } = await import("./style.ts");

const renderContext = (state: object, isPartial: boolean, isError: boolean, lastComponent?: any, expanded = false) => ({
	args: {},
	toolCallId: "call",
	invalidate() {},
	lastComponent,
	state,
	cwd: "/tmp",
	executionStarted: true,
	argsComplete: true,
	isPartial,
	expanded,
	showImages: true,
	isError,
});

describe("withStatusCard", () => {
	test("uses the terminal background, indents body lines, and shows status throughout execution", () => {
		const colors: string[] = [];
		const theme = {
			bg(role: string, text: string) {
				colors.push(role);
				return text;
			},
			bold: (text: string) => text,
			fg: (role: string, text: string) => {
				colors.push(role);
				return text;
			},
		};
		const tool = withStatusCard({
			name: "demo",
			label: "demo",
			description: "demo",
			parameters: {} as any,
			async execute() { return { content: [] }; },
			renderCall: () => new MockText("demo\narguments"),
			renderResult: () => new MockText("result\nmore"),
		});
		const state = {};

		const pending = tool.renderCall?.({}, theme as any, renderContext(state, true, false) as any) as MockBox;
		expect(pending.render(80)[0]).toBe("● demo");
		expect(pending.background).toBeUndefined();
		expect(colors).toContain("warning");
		tool.renderResult?.({ content: [] }, { expanded: false, isPartial: true }, theme as any, renderContext(state, true, false) as any);
		tool.renderResult?.({ content: [] }, { expanded: false, isPartial: true }, theme as any, renderContext(state, true, false) as any);
		expect(pending.render(80)).toEqual(["● demo", "    arguments", "    result", "    more"]);

		const successful = tool.renderCall?.({}, theme as any, renderContext(state, false, false, pending) as any) as MockBox;
		tool.renderResult?.({ content: [] }, { expanded: false, isPartial: false }, theme as any, renderContext(state, false, false) as any);
		expect(successful.render(80)).toEqual(["✓ demo", "    arguments", "    result", "    more"]);
		expect(colors).not.toContain("toolPendingBg");
		expect(colors).toContain("success");

		const failed = tool.renderCall?.({}, theme as any, renderContext(state, false, true, successful) as any) as MockBox;
		expect(failed.render(80)[0]).toBe("✗ demo");
		expect(colors).toContain("error");
	});

	test("marks any returned error as a failure, for every tool", () => {
		expect(returnedErrorPatch("todo", { error: "missing id" })).toEqual({ isError: true });
		expect(returnedErrorPatch("bg_process", { error: "missing job" })).toEqual({ isError: true });
		expect(returnedErrorPatch("edit", { error: "boom" })).toEqual({ isError: true });
		expect(returnedErrorPatch("bash", { error: "killed" })).toEqual({ isError: true });
		expect(returnedErrorPatch("todo", {})).toBeUndefined();
		expect(returnedErrorPatch("read", { error: 42 })).toBeUndefined();
	});

	test("hides earlier lines while keeping the latest lines visible", () => {
		const tool = withStatusCard({
			name: "demo",
			label: "demo",
			description: "demo",
			parameters: {} as any,
			async execute() { return { content: [] }; },
			renderCall: () => new MockText("demo"),
			renderResult: () => new MockText("line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8"),
		});
		const state = {};
		const theme = {
			bold: (text: string) => text,
			fg: (_role: string, text: string) => text,
		};
		const card = tool.renderCall?.({}, theme as any, renderContext(state, false, false) as any) as MockBox;

		tool.renderResult?.({ content: [] }, { expanded: false, isPartial: false }, theme as any, renderContext(state, false, false) as any);
		expect(card.render(80)).toEqual([
			"✓ demo",
			"    … 2 lines hidden",
			"    line 3",
			"    line 4",
			"    line 5",
			"    line 6",
			"    line 7",
			"    line 8",
		]);

		tool.renderResult?.({ content: [] }, { expanded: true, isPartial: false }, theme as any, renderContext(state, false, false, undefined, true) as any);
		expect(card.render(80)).toEqual([
			"✓ demo",
			"    line 1",
			"    line 2",
			"    line 3",
			"    line 4",
			"    line 5",
			"    line 6",
			"    line 7",
			"    line 8",
		]);
	});
});

class FakeToolComponent {
	toolName: string;
	toolDefinition: any;
	builtInToolDefinition: any;

	constructor(toolName: string, toolDefinition?: any, builtInToolDefinition?: any) {
		this.toolName = toolName;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = builtInToolDefinition;
	}

	getRenderShell() { return this.toolDefinition?.renderShell ?? this.builtInToolDefinition?.renderShell ?? "default"; }
	getCallRenderer() { return this.toolDefinition?.renderCall ?? this.builtInToolDefinition?.renderCall; }
	getResultRenderer() { return this.toolDefinition?.renderResult ?? this.builtInToolDefinition?.renderResult; }
	hasRendererDefinition() { return !!(this.toolDefinition || this.builtInToolDefinition); }
}

describe("installGlobalStatusCards", () => {
	// Idempotent; a single install patches the prototype for all tests below.
	installGlobalStatusCards(FakeToolComponent);

	test("wraps tools without self rendering so every call gets a status card", () => {
		const component = new FakeToolComponent("edit");
		const colors: string[] = [];
		const theme = {
			bg: () => "",
			bold: (text: string) => text,
			fg(role: string, text: string) {
				colors.push(role);
				return text;
			},
		};
		const renderCall = component.getCallRenderer()!;
		const box = renderCall({}, theme as any, renderContext({}, true, false) as any) as MockBox;
		expect(box.render(80)[0]).toBe("● edit");
		expect(colors).toContain("warning");

		const renderResult = component.getResultRenderer()!;
		renderResult({ content: [{ type: "text", text: "changed 1 file" }] }, { expanded: false, isPartial: false }, theme as any, renderContext({}, false, false) as any);
		expect(box.render(80)).toEqual(["● edit", "    changed 1 file"]);
	});

	test("keeps failing calls marked ✗", () => {
		const component = new FakeToolComponent("write");
		const theme = {
			bg: () => "",
			bold: (text: string) => text,
			fg: (_role: string, text: string) => text,
		};
		const box = component.getCallRenderer()!({}, theme as any, renderContext({}, false, true) as any) as MockBox;
		expect(box.render(80)[0]).toBe("✗ write");
	});

	test("limits fallback output to the latest lines while hiding earlier lines", () => {
		const component = new FakeToolComponent("read");
		const theme = {
			bg: () => "",
			bold: (text: string) => text,
			fg: (_role: string, text: string) => text,
		};
		const box = component.getCallRenderer()!({}, theme as any, renderContext({}, false, false) as any) as MockBox;
		component.getResultRenderer()!(
			{ content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8" }] },
			{ expanded: false, isPartial: false },
			theme as any,
			renderContext({}, false, false) as any,
		);
		expect(box.render(80)).toEqual([
			"✓ read",
			"    … 2 lines hidden",
			"    line 3",
			"    line 4",
			"    line 5",
			"    line 6",
			"    line 7",
			"    line 8",
		]);
	});

	test("does not double-wrap tools that already render themselves", () => {
		const renderCall = () => new MockText("custom");
		const renderResult = () => new MockText("custom result");
		const component = new FakeToolComponent("bash", { renderShell: "self", renderCall, renderResult });
		expect(component.getCallRenderer()).toBe(renderCall);
		expect(component.getResultRenderer()).toBe(renderResult);
		expect(component.getRenderShell()).toBe("self");
	});

	test("uses special renderers for self-rendered builtins on their first call", () => {
		installSpecialToolRenderer("edit", (() => new MockText("highlighted edit")) as any, (() => new MockText("result")) as any);
		const component = new FakeToolComponent("edit", { renderShell: "self", renderCall: () => new MockText("old"), renderResult: () => new MockText("old result") });
		const renderer = component.getCallRenderer()!;
		const card = renderer({}, { bg: () => "", bold: (text: string) => text, fg: (_role: string, text: string) => text } as any, renderContext({}, false, false) as any) as MockBox;
		expect(card.render(80)[0]).toBe("✓ highlighted edit");
	});
});
