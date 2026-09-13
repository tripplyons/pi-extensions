import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./config.ts";
import { configure, controlCard, Inspector } from "./ui.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;

test("control cards and the inspector stay within narrow terminals and support scrolling", () => {
	const body = `Reviewer: provider/very-long-model-name\n[blocker] check the actual file\n${"evidence on another line\n".repeat(30)}`;
	const collapsed = controlCard(body, false, theme).render(24);
	const expanded = controlCard(body, true, theme).render(24);
	expect(collapsed).toHaveLength(1);
	expect(expanded.length).toBeGreaterThan(collapsed.length);
	expect([...collapsed, ...expanded].every(line => visibleWidth(line) <= 24)).toBe(true);
	let closed = false;
	const view = new Inspector(body, () => 8, () => {}, () => { closed = true; });
	const first = view.render(24);
	view.handleInput("\x1b[6~");
	expect(view.render(24)).not.toEqual(first);
	expect(view.render(24).length).toBeLessThanOrEqual(8);
	view.handleInput("\x1b");
	expect(closed).toBe(true);
});

test("configuration supports disabled reviewers, guidance and limits without mutating the proposal source", async () => {
	const original = defaultConfig();
	const before = JSON.stringify(original);
	const model = { provider: "fixture", id: "lead", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000 };
	const ctx = { hasUI: true, isIdle: () => true, modelRegistry: { getAvailable: () => [model], find: () => model }, ui: {
		select: async (label: string, options: string[]) => label === "Independent reviewers" ? "0" : options[0],
		editor: async (_label: string, value: string) => { const config = JSON.parse(value); config.presets.default.writer.guidance = "Run focused tests"; config.presets.default.limits.writerTurns = 5; return JSON.stringify(config); },
		confirm: async () => true,
	} } as unknown as ExtensionCommandContext;
	const config = await configure(ctx, original);
	expect(config?.presets.default.reviewers).toEqual([]);
	expect(config?.presets.default.writer.guidance).toBe("Run focused tests");
	expect(config?.presets.default.limits.writerTurns).toBe(5);
	expect(JSON.stringify(original)).toBe(before);
	ctx.ui.confirm = async () => false;
	expect(await configure(ctx, original)).toBeUndefined();
});

test("print mode and active tasks get actionable errors instead of TUI-only callbacks", async () => {
	await expect(configure({ hasUI: false } as ExtensionCommandContext, defaultConfig())).rejects.toThrow("edit mixture.json directly");
	await expect(configure({ hasUI: true, isIdle: () => false } as ExtensionCommandContext, defaultConfig())).rejects.toThrow("only while idle");
});
