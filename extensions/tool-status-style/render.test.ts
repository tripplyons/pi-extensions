import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({
	getLanguageFromPath: (path: string) => path.endsWith(".ts") ? "typescript" : undefined,
	highlightCode: (code: string) => code.split("\n").map((line) => `<syntax>${line}</syntax>`),
}));

mock.module("@earendil-works/pi-tui", () => ({
	Text: class {
		constructor(public text: string) {}
		setText(text: string) { this.text = text; }
		invalidate() {}
		render() { return this.text.split("\n"); }
	},
	sliceByColumn: (text: string, start: number, length: number) => text.slice(start, start + length),
	visibleWidth: (text: string) => text.replace(/<[^>]+>/g, "").length,
}));

const { formatFileToolCall, intraLineDiff, renderLines } = await import("./render.ts");

const theme = {
	bold: (text: string) => text,
	fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
};

describe("syntax-highlighted file previews", () => {
	test("highlights complete source lines", () => {
		expect(renderLines("const value = 1;\nvalue++", "example.ts")).toEqual([
			{ text: "const value = 1;", highlighted: "<syntax>const value = 1;</syntax>" },
			{ text: "value++", highlighted: "<syntax>value++</syntax>" },
		]);
	});

	test("marks only changed tokens in paired diff lines", () => {
		expect(intraLineDiff("const oldName = 1;", "const newName = 1;")).toEqual({
			removed: [
				{ text: "const ", changed: false },
				{ text: "oldName", changed: true },
				{ text: " = 1;", changed: false },
			],
			added: [
				{ text: "const ", changed: false },
				{ text: "newName", changed: true },
				{ text: " = 1;", changed: false },
			],
		});
	});

	test("renders generated edit diffs without the built-in background box", () => {
		const output = formatFileToolCall(theme as any, "edit", "example.ts", {
			diff: "  1 const value = 1;\n- 2 const oldName = 1;\n+ 2 const newName = 1;",
		});
		expect(output).toContain("<toolTitle>edit</toolTitle> example.ts");
		expect(output).toContain("<toolDiffRemoved>- ");
		expect(output).toContain("<toolDiffAdded>+ ");
		expect(output).toContain("<toolDiffRemoved>oldName</toolDiffRemoved>");
	});
});
