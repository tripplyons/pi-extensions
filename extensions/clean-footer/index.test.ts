import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

const { default: cleanFooterExtension } = await import("./index.ts");

type Handler = (event: unknown, ctx: any) => unknown;

const createHarness = () => {
	const handlers = new Map<string, Handler>();
	const workingVisibility: boolean[] = [];
	const statuses = new Map<string, string>();
	const entries: any[] = [];
	let footerFactory: any;
	let renderRequests = 0;
	const foregroundCalls: Array<{ role: string; text: string }> = [];

	const pi = {
		getThinkingLevel: () => "high",
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	const ctx = {
		cwd: "/tmp/project-folder",
		getContextUsage: () => ({ contextWindow: 200_000, percent: 39.5, tokens: 79_000 }),
		mode: "tui",
		model: { contextWindow: 200_000, id: "test-model" },
		sessionManager: { getEntries: () => entries },
		ui: {
			setFooter(factory: any) {
				footerFactory = factory;
			},
			setWorkingVisible(visible: boolean) {
				workingVisibility.push(visible);
			},
		},
	};
	const theme = {
		bold: (text: string) => text,
		fg: (role: string, text: string) => {
			foregroundCalls.push({ role, text });
			return text;
		},
	};
	const footerData = {
		getExtensionStatuses: () => statuses,
	};

	cleanFooterExtension(pi as any);

	return {
		ctx,
		footer: () => footerFactory({ requestRender: () => renderRequests++ }, theme, footerData),
		foregroundCalls,
		handlers,
		renderRequests: () => renderRequests,
		workingVisibility,
		statuses,
		entries,
	};
};

describe("clean footer working indicator", () => {
	test("hides the working row and shows a static marker before the folder", async () => {
		const harness = createHarness();

		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const footer = harness.footer();
		expect(footer.render(200)[0]).toStartWith("project-folder | test-model | high");
		expect(footer.render(200)[0]).toContain("39.5%/200k");
		expect(harness.workingVisibility).toEqual([false]);

		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		harness.foregroundCalls.length = 0;
		expect(footer.render(200)[0]).toStartWith("[*] project-folder | test-model | high");
		expect(harness.foregroundCalls).toContainEqual({ role: "accent", text: "[*]" });
		expect(harness.foregroundCalls).toContainEqual({ role: "accent", text: "project-folder" });
		expect(harness.renderRequests()).toBe(1);
		await Bun.sleep(100);
		expect(harness.renderRequests()).toBe(1);

		await harness.handlers.get("agent_settled")?.({}, harness.ctx);
		expect(footer.render(200)[0]).toStartWith("project-folder | test-model | high");

		await harness.handlers.get("session_shutdown")?.({}, harness.ctx);
		expect(harness.workingVisibility).toEqual([false, true]);
		footer.dispose();
	});

	test("counts successful and failed compaction as running", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const footer = harness.footer();

		await harness.handlers.get("session_before_compact")?.({}, harness.ctx);
		expect(footer.render(200)[0]).toStartWith("[*] project-folder");
		expect(harness.renderRequests()).toBe(1);
		await harness.handlers.get("session_compact")?.({}, harness.ctx);
		expect(footer.render(200)[0]).toStartWith("project-folder");
		expect(harness.renderRequests()).toBe(2);

		await harness.handlers.get("session_before_compact")?.({}, harness.ctx);
		expect(footer.render(200)[0]).toStartWith("[*] project-folder");
		await harness.handlers.get("session_compact_failed")?.({}, harness.ctx);
		expect(footer.render(200)[0]).toStartWith("project-folder");
		expect(harness.renderRequests()).toBe(4);

		await harness.handlers.get("agent_start")?.({}, harness.ctx);
		await harness.handlers.get("session_before_compact")?.({}, harness.ctx);
		await harness.handlers.get("session_compact")?.({}, harness.ctx);
		expect(footer.render(200)[0]).toStartWith("[*] project-folder");
		expect(harness.renderRequests()).toBe(5);
		await harness.handlers.get("agent_settled")?.({}, harness.ctx);
		expect(footer.render(200)[0]).toStartWith("project-folder");
		expect(harness.renderRequests()).toBe(6);
	});
});

describe("clean footer extension statuses", () => {
	test("keeps Mixture identity and progress visible on narrow terminals", async () => {
		const harness = createHarness();
		Object.assign(harness.ctx.model, { provider: "mixture", id: "default" });
		harness.statuses.set("mixture", "mix writer r3 · review 2 · $0.004");
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const lines = harness.footer().render(60);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("mixture/default");
		expect(lines[1]).toContain("writer r3 · review 2");
		expect(lines.every((line: string) => visibleWidth(line) <= 60)).toBe(true);
		expect(harness.footer().render(200)).toHaveLength(1);
	});
	test("shows local mode when enabled", async () => {
		const harness = createHarness();
		harness.statuses.set("local", "local on");

		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const footer = harness.footer();

		expect(footer.render(200)[0]).toContain("$0.00 | local");
	});

	test("hides the Codex adapter status and shows other statuses", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		harness.statuses.set("codex-adapter", "\x1b[32mCode | Remote | Hybrid\x1b[0m");
		harness.statuses.set("other-package", "waiting for input");
		expect(harness.footer().render(200)[0]).toContain("$0.00 | waiting for input");
		expect(harness.footer().render(200)[0]).not.toContain("Remote");
		harness.statuses.delete("other-package");
		expect(harness.footer().render(200)[0]).not.toContain("waiting for input");
		expect(visibleWidth(harness.footer().render(30)[0])).toBeLessThanOrEqual(30);
	});

	test("includes nested tool, compaction and branch-summary usage without changing context pressure", async () => {
		const harness = createHarness();
		harness.entries.push(
			{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } },
			{ type: "message", message: { role: "toolResult", usage: { cost: { total: 0.25 } } } },
			{ type: "message", message: { role: "toolResult" } },
			{ type: "compaction", usage: { cost: { total: 0.1 } } },
			{ type: "branch_summary", usage: { cost: { total: 0.05 } } },
			{ type: "custom", data: { usage: { cost: { total: 999 } } } },
		);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const rendered = harness.footer().render(200)[0];
		expect(rendered).toContain("$1.40");
		expect(rendered).toContain("39.5%/200k");
	});

	test("keeps the cost total from decreasing after context changes", async () => {
		const harness = createHarness();
		harness.entries.push({
			type: "message",
			message: { role: "assistant", usage: { cost: { total: 1.23 } } },
		});

		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const footer = harness.footer();
		expect(footer.render(200)[0]).toContain("$1.23");

		// Compression changes only the provider context, but preserve the displayed
		// high-water mark even if a later session snapshot omits old entries.
		harness.entries.length = 0;
		expect(footer.render(200)[0]).toContain("$1.23");
	});
});
