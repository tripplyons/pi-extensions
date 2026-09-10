import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
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
	test("removes Prompts and Themes while preserving requested sections and errors", () => {
		let invalidations = 0;
		const leaf = (text: string) => ({ invalidate() {}, render: () => [text] });
		const root = {
			children: [
				leaf("[Context]"), leaf("[Skills]"), leaf("[Prompts]"), leaf("[Themes]"), leaf(""),
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
