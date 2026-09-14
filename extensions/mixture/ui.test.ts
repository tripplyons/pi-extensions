import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./config.ts";
import type { Registry } from "./provider.ts";
import { newReviewer } from "./review.ts";
import { MixtureSession, newState } from "./session.ts";
import { compactStatus, configure, controlCard, inspection, Inspector } from "./ui.ts";

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

test("compact status follows handoffs, recorded blockers, takeover and idle without hiding inspection data", async () => {
	const preset = defaultConfig().presets.default;
	preset.reviewers = [];
	const session = new MixtureSession(preset, {} as Registry, newState("default", preset), () => ({ available: true, jobs: [] }));
	const status = () => compactStatus(session);
	const control = async (input: any) => {
		const id = crypto.randomUUID();
		session.state.origins[id] = { actor: session.active, synthetic: false };
		return session.control(id, input);
	};
	expect(status()).toBe("lead · idle · $0.000");
	session.newRequest("Fix the fixture");
	expect(status()).toBe("lead · planning · $0.000");
	await control({ action: "delegate", task: "Fix the fixture", nextAction: "Apply the known repair", successCriteria: ["Check passes"] });
	expect(status()).toBe("writer · working · $0.000");
	await control({ action: "escalate", report: "Authorization is missing" });
	expect(status()).toBe("lead · assessing · $0.000");
	await control({ action: "assess", phaseId: session.state.phase!.id, assessment: "blocked", evidence: "User has not approved the repair", blocker: "Explicit authorization is required" });
	expect(status()).toBe("lead · blocked · $0.000");
	await session.abort();
	session.reconcile("request ended");
	expect(status()).toBe("lead · blocked · $0.000");
	session.resumeLoop();
	await control({ action: "takeover" });
	expect(status()).toBe("lead · working · $0.000");
	session.state.lead.usage.cost.total = 0.01;
	session.state.writer.usage.cost.total = 0.02;
	const reviewer = newReviewer();
	reviewer.usage.cost.total = 0.03;
	reviewer.warning = "Review incomplete";
	session.state.reviewers.push(reviewer);
	expect(status()).toBe("lead · working · $0.060");
	expect(compactStatus(session, true)).toBe("lead · compacting · $0.060");
	// Keep the inspection roster consistent with the synthetic reviewer.
	preset.reviewers.push({ model: "fixture/reviewer", thinking: "off" });
	expect(inspection(session)).toContain("Review incomplete");
	expect(inspection(session)).toContain("queued reviews:");
	expect(inspection(session)).toContain("Phase ID:");
	await control({ action: "assess", phaseId: session.state.phase!.id, assessment: "complete", evidence: "Repair verified under the approved lead takeover" });
	await session.abort();
	session.reconcile("request ended");
	expect(status()).toBe("lead · idle · $0.060");
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
