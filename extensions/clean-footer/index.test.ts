import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-tui", () => ({
	truncateToWidth: (text: string) => text,
}));

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
});

describe("clean footer extension statuses", () => {
	test("shows local mode when enabled", async () => {
		const harness = createHarness();
		harness.statuses.set("local", "local on");

		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const footer = harness.footer();

		expect(footer.render(200)[0]).toContain("$0.00 | local");
	});

	test("shows fusion while enabled, regardless of progress status", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		harness.statuses.set("model-fusion", "fusion on");
		harness.statuses.set("model-fusion-progress", "background review");
		expect(harness.footer().render(200)[0]).toContain("$0.00 | fusion");
		harness.statuses.delete("model-fusion");
		expect(harness.footer().render(200)[0]).not.toContain("fusion");
	});

	test("shows an active goal", async () => {
		const harness = createHarness();
		harness.statuses.set("goal", "goal on");

		await harness.handlers.get("session_start")?.({}, harness.ctx);

		expect(harness.footer().render(200)[0]).toContain("$0.00 | goal");
	});

	test("shows compression only while enabled", async () => {
		const harness = createHarness();
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const footer = harness.footer();
		expect(footer.render(200)[0]).not.toContain("compression");
		harness.statuses.set("context-compression", "compression on");
		expect(footer.render(200)[0]).toContain("$0.00 | compression");
		harness.statuses.delete("context-compression");
		expect(footer.render(200)[0]).not.toContain("compression");
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
