import { describe, expect, test } from "bun:test";
import { Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import startupScreenExtension, {
	displayDirectory,
	removeHiddenSection,
	renderHeader,
} from "./index.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_role: string, text: string) => text,
};

describe("startup header", () => {
	test("renders a centered PI logo and abbreviated directory within the width", () => {
		const lines = renderHeader(theme as any, "/Users/tripp/projects/pi-extensions", 32);
		expect(lines.join("\n")).toContain("██████╗ ██╗");
		expect(lines.join("\n")).toContain("~/projects/pi-extensions");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
	});

	test("formats home and external paths", () => {
		expect(displayDirectory("/home/me", "/home/me")).toBe("~");
		expect(displayDirectory("/home/me/code", "/home/me")).toBe("~/code");
		expect(displayDirectory("/tmp/code", "/home/me")).toBe("/tmp/code");
	});
});

describe("resource filtering", () => {
	test("keeps the chat attached when only hidden resource sections remain", () => {
		const root = new Container();
		const document = new Container();
		const resources = new Container();
		const chat = new Container();
		const section = new Text("[Themes]\n  global", 0, 0);
		Object.assign(section, {
			getExpandedText: () => "[Themes]\n  global",
			getCollapsedText: () => "[Themes]\n  global",
		});
		resources.addChild(section);
		resources.addChild(new Spacer(1));
		document.addChild(new Text("PI", 0, 0));
		document.addChild(resources);
		document.addChild(chat);
		root.addChild(document);

		while (removeHiddenSection(root)) {}
		expect(document.children).toContain(resources);
		expect(document.children).toContain(chat);
		expect(resources.children).toEqual([]);
		chat.addChild(new Text("User prompt\nAssistant reply\nTool output", 0, 0));
		while (removeHiddenSection(root)) {}
		expect(root.render(80).join("\n")).toContain("Assistant reply");
		expect(root.render(80).join("\n")).toContain("Tool output");
	});

	test("preserves blank live components and ordinary text matching a heading", () => {
		const root = new Container();
		const section = new Text("[Prompts]", 0, 0);
		Object.assign(section, { getExpandedText: () => "[Prompts]" });
		const live = new Text("", 0, 0);
		root.addChild(section);
		root.addChild(live);
		root.addChild(new Text("[Themes]\nThis is conversation text", 0, 0));
		while (removeHiddenSection(root)) {}
		live.setText("Streaming output");
		expect(root.render(80).join("\n")).toContain("Streaming output");
		expect(root.render(80).join("\n")).toContain("This is conversation text");
	});

	test("filters collapsed and expanded lists by scope and drops empty sections", () => {
		class Section extends Text {
			constructor(public getCollapsedText: () => string, public getExpandedText: () => string) {
				super(getCollapsedText(), 0, 0);
			}
			setExpanded() { this.setText(this.getExpandedText()); }
		}
		const root = new Container();
		const context = new Section(() => "[Context]\n  AGENTS.md, global", () =>
			`[Context]\n  ${displayDirectory(getAgentDir())}/AGENTS.md\n  /tmp/project/AGENTS.md`);
		const skills = new Section(() => "[Skills]\n  local, global", () =>
			"[Skills]\n  project\n    /tmp/project/.agents/skills/local/SKILL.md\n    npm:project-skills\n      package-skill/SKILL.md\n  user\n    global\n  path\n    temporary");
		const extensions = new Section(() => "[Extensions]\n  global", () => "[Extensions]\n  user\n    npm:global");
		for (const section of [context, skills, extensions]) root.addChild(section);
		while (removeHiddenSection(root)) {}
		for (const expanded of [false, true]) {
			if (expanded) { context.setExpanded(); skills.setExpanded(); }
			const output = root.render(200).join("\n");
			expect(output).toContain("/tmp/project/AGENTS.md");
			expect(output).toContain("npm:project-skills");
			expect(output).not.toContain("global");
			expect(output).not.toContain("temporary");
			expect(output).not.toContain("[Extensions]");
			expect(output).not.toContain(displayDirectory(getAgentDir()));
		}
		expect(removeHiddenSection(root)).toBe(false);
	});

	test("removes Prompts and Themes while preserving requested sections and errors", () => {
		let invalidations = 0;
		const leaf = (text: string) => ({
			getExpandedText: text === "[Prompts]" || text === "[Themes]" ? () => text : undefined,
			setText() {}, invalidate() {}, render: () => [text],
		});
		const root = {
			children: [
				leaf("[Context]"), leaf("[Skills]"), leaf("[Prompts]"), leaf("[Themes]"), new Spacer(1),
				leaf("[Extensions]"), leaf("Extension errors:\nfailed.ts"),
			],
			invalidate: () => invalidations++,
			render: () => [],
		};
		expect(removeHiddenSection(root)).toBe(true);
		expect(removeHiddenSection(root)).toBe(true);
		expect(root.children.map((child) => child.render(200)[0])).toEqual([
			"[Context]", "[Skills]", "[Extensions]", "Extension errors:\nfailed.ts",
		]);
		expect(invalidations).toBe(2);
	});

	test("fails open when hidden sections are absent", () => {
		const root = { children: [], invalidate() {}, render: () => [] };
		expect(removeHiddenSection(root)).toBe(false);
	});
});

describe("extension lifecycle", () => {
	test("installs only in TUI mode and restores the built-in header", async () => {
		const handlers = new Map<string, Function>();
		const headers: unknown[] = [];
		startupScreenExtension({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
		const ui = { setHeader: (header: unknown) => headers.push(header) };

		await handlers.get("session_start")?.({}, { cwd: "/tmp", mode: "rpc", ui });
		expect(headers).toEqual([]);
		await handlers.get("session_start")?.({}, { cwd: "/tmp", mode: "tui", ui });
		expect(headers).toHaveLength(1);
		let renderRequests = 0;
		(headers[0] as Function)({
			children: [],
			invalidate() {},
			render: () => [],
			requestRender: () => renderRequests++,
		}, theme);
		await handlers.get("session_shutdown")?.({}, { mode: "tui", ui });
		expect(headers).toEqual([expect.any(Function), undefined]);
		await Bun.sleep(10);
		expect(renderRequests).toBe(0);
	});
});
