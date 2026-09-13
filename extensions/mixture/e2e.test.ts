import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { defaultConfig } from "./config.ts";
import { createMixtureExtension } from "./index.ts";
import { CHECKPOINT, parseCheckpoint } from "./checkpoint.ts";
import { modelDefinition, validatePreset } from "./provider.ts";

const live = process.env.PI_MIXTURE_E2E === "1";
(live ? test : test.skip)("live approved roster edits, verifies and independently reviews a disposable file", async () => {
	// Resolve the existing auth store before changing the temporary agent directory.
	// No credentials are copied or printed; refresh remains with Pi's auth runtime.
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const registry = new ModelRegistry(runtime);
	const config = defaultConfig();
	const preset = config.presets.default;
	Object.assign(preset.limits, { writerTurns: 8, reviewerBatchTurns: 2,
		catchUpMs: 45_000, requestTimeoutMs: 90_000, leadMaxTokens: 2048, writerMaxTokens: 4096, reviewerMaxTokens: 2048, maxCostUsd: 2 });
	validatePreset(preset, registry.find.bind(registry));
	const dir = mkdtempSync(join(tmpdir(), "mixture-live-"));
	const agentDir = join(dir, "agent"); const cwd = join(dir, "work");
	mkdirSync(agentDir); mkdirSync(cwd);
	const previous = process.env.PI_CODING_AGENT_DIR;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const errors: unknown[] = [];
	console.log(`Live smoke artifacts: ${dir}`);
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "mixture.json"), JSON.stringify(config));
		writeFileSync(join(cwd, "fixture.txt"), "before\n");
		writeFileSync(join(cwd, "unrelated.txt"), "preserve this user content\n");
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi: ExtensionAPI) => createMixtureExtension(pi, registry)] });
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: settings,
			sessionManager: SessionManager.create(cwd, join(dir, "sessions")), modelRuntime: runtime,
			model: modelDefinition("default", preset, registry.find.bind(registry)), thinkingLevel: "low" }));
		await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
		const timeout = setTimeout(() => { void session?.abort(); }, 300_000);
		try {
			await session.prompt("Use the writer to replace the single line before with after in fixture.txt. Preserve unrelated.txt. Verify the exact contents with read and a short shell assertion. Keep all outputs short. Independent reviewers should inspect the completed edit; the unchanged initial file is not a defect before execution. End with a brief verified result.");
		} finally { clearTimeout(timeout); }
		const entries = session.sessionManager.getEntries();
		const entry = entries.findLast(entry => entry.type === "custom" && entry.customType === CHECKPOINT);
		expect(entry?.type).toBe("custom");
		const state = parseCheckpoint((entry as any).data).state;
		const stats = session.getSessionStats();
		const summary = {
			path: dir, models: { lead: preset.lead, writer: preset.writer.model, reviewers: preset.reviewers.map(role => role.model) },
			roles: [state.lead, state.writer, ...state.reviewers].map(role => ({ calls: role.calls, usage: role.usage })),
			reviewers: state.reviewers.map(role => ({ status: role.status, revision: role.revision, warning: role.warning, findings: role.findings })),
			cost: stats.cost, tokens: stats.tokens, final: session.messages.at(-1), errors,
		};
		writeFileSync(join(dir, "result.json"), JSON.stringify(summary, null, 2));
		console.log(JSON.stringify({ path: dir, calls: summary.roles.map(role => role.calls), cost: stats.cost, tokens: stats.tokens.total, reviewers: summary.reviewers.map(role => ({ status: role.status, warning: role.warning })) }));
		expect(errors).toEqual([]);
		expect(readFileSync(join(cwd, "fixture.txt"), "utf8")).toBe("after\n");
		expect(readFileSync(join(cwd, "unrelated.txt"), "utf8")).toBe("preserve this user content\n");
		expect(state.writer.calls).toBeGreaterThan(0);
		expect(state.lead.calls).toBeGreaterThan(0);
		for (const reviewer of state.reviewers) {
			expect(reviewer.calls).toBeGreaterThan(0);
			expect(reviewer.warning).toBeUndefined();
			expect(reviewer.revision).toBe(state.revision);
			expect(reviewer.findings.filter(finding => finding.severity !== "nit")).toEqual([]);
		}
		expect(session.messages.some(message => message.role === "toolResult" && message.toolName === "bash" && !message.isError)).toBe(true);
		expect((session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
	} finally {
		if (session) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		// Retain only the test's fixture/config/session evidence for the plan audit.
	}
}, 330_000);
