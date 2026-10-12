import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");
const { default: extensionManager } = await import("./index.ts");

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";

let root: string;
let agentDir: string;
let packageDir: string;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function settings(): any {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
}

function harness(mode = "tui") {
	let command: any;
	let component: any;
	let opened: Promise<void> = Promise.resolve();
	let markOpened: () => void = () => {};
	const notifications: string[] = [];
	let reloads = 0;
	const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		mode,
		cwd: root,
		ui: {
			notify: (message: string) => notifications.push(message),
			custom: (factory: any) => new Promise<void>(resolve => {
				component = factory({ terminal: { rows: 40 }, requestRender: () => {} }, theme, undefined, () => resolve());
				markOpened();
			}),
		},
		waitForIdle: async () => {},
		reload: async () => {
			reloads++;
		},
	};
	extensionManager({ registerCommand: (name: string, value: any) => name === "extensions" && (command = value) } as any);
	return {
		async open(): Promise<{ run: Promise<void> }> {
			opened = new Promise(resolve => (markOpened = resolve));
			const run = command.handler("", ctx);
			await Promise.race([opened, run]);
			return { run };
		},
		render: () => stripVTControlCharacters(component.render(120).join("\n")),
		press: (...keys: string[]) => keys.forEach(key => component.handleInput(key)),
		notifications,
		reloads: () => reloads,
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "extension-manager-"));
	agentDir = join(root, "agent");
	packageDir = join(root, "package");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(join(packageDir, "extensions", "alpha"), { recursive: true });
	writeFileSync(join(packageDir, "extensions", "alpha", "index.ts"), "export default () => {};\n");
	writeFileSync(join(packageDir, "extensions", "beta.ts"), "export default () => {};\n");
	writeFileSync(join(agentDir, "extensions", "gamma.ts"), "export default () => {};\n");
	writeJson(join(packageDir, "package.json"), {
		name: "fixture",
		keywords: ["pi-package"],
		pi: { extensions: ["./extensions/alpha/index.ts", "./extensions/beta.ts"] },
	});
	writeJson(join(agentDir, "settings.json"), { packages: [packageDir] });
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

describe("/extensions", () => {
	test("lists package and top-level extensions as enabled by default", async () => {
		const ui = harness();
		const { run } = await ui.open();
		const view = ui.render();
		expect(view).toMatch(/alpha\s+enabled/);
		expect(view).toMatch(/beta\s+enabled/);
		expect(view).toMatch(/gamma\s+enabled/);
		ui.press(ESCAPE);
		await run;
		expect(ui.reloads()).toBe(0);
		expect(settings()).toEqual({ packages: [packageDir] });
	});

	test("disables a package extension in global settings and reloads", async () => {
		const ui = harness();
		const { run } = await ui.open();
		ui.press(ENTER);
		expect(ui.render()).toMatch(/alpha\s+disabled/);
		ui.press(ESCAPE);
		await run;
		expect(settings().packages).toEqual([{ source: packageDir, extensions: ["-extensions/alpha/index.ts"] }]);
		expect(ui.reloads()).toBe(1);

		const reopened = harness();
		const { run: rerun } = await reopened.open();
		expect(reopened.render()).toMatch(/alpha\s+disabled/);
		reopened.press(ENTER, ESCAPE);
		await rerun;
		expect(settings().packages).toEqual([packageDir]);
	});

	test("disables a top-level extension", async () => {
		const ui = harness();
		const { run } = await ui.open();
		ui.press(DOWN, DOWN, ENTER, ESCAPE);
		await run;
		expect(settings().extensions).toEqual(["-extensions/gamma.ts"]);
		expect(settings().packages).toEqual([packageDir]);
	});

	test("skips reload when a toggle is undone before closing", async () => {
		const ui = harness();
		const { run } = await ui.open();
		ui.press(DOWN, ENTER, ENTER, ESCAPE);
		await run;
		expect(ui.reloads()).toBe(0);
		expect(settings().packages).toEqual([packageDir]);
	});

	test("explains the CLI alternative outside the TUI", async () => {
		const ui = harness("rpc");
		await (await ui.open()).run;
		expect(ui.notifications).toEqual(["/extensions requires the TUI. Use `pi config` instead."]);
	});
});
