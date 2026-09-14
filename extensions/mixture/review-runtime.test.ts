import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Message, type Provider, type Usage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getLastAssistantUsage, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./config.ts";
import cleanFooter, { sessionCost } from "../clean-footer/index.ts";
import { createMixtureExtension } from "./index.ts";
import { addUsage, emitMessage, emptyUsage, modelDefinition, type Registry } from "./provider.ts";

const tool = (name: string, args: Record<string, unknown>): AssistantMessage["content"] => [{ type: "toolCall", id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args }];
const good = "export const abs = (x) => x < 0 ? -x : x;\n";
const bad = "export const abs = (x) => x;\n";
const usage = (): Usage => ({ input: 10, output: 1, cacheRead: 2, cacheWrite: 3, totalTokens: 16,
	cost: { input: 0.0004, output: 0.0003, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.001 } });

for (const mode of ["correct", "failed", "slow", "abort"] as const) test(`real Pi independent review: ${mode}`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "mixture-reviewed-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const preset = defaultConfig().presets.default;
		preset.lead = "fixture/lead"; preset.writer.model = "fixture/writer";
		preset.reviewers = ["reviewer-a", "reviewer-b"].map(id => ({ model: `fixture/${id}`, thinking: "low" }));
		preset.limits.catchUpMs = 30;
		preset.limits.requestTimeoutMs = 1000;
		writeFileSync(join(dir, "mixture.json"), JSON.stringify({ version: 2, presets: { default: preset } }));
		const find: Registry["find"] = (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0.1 } });
		const statuses = new Map<string, string>();
		const displays: string[] = [];
		let footer: { render(width: number): string[] } | undefined;
		const requests: Array<{ id: string; context: Context; display?: string }> = [];
		const billed: Usage[] = [];
		let leadCalls = 0;
		let correctionAssessed = false;
		let writerCalls = 0;
		const provider: Provider = {
			id: "fixture", name: "Fixture", auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => ["lead", "writer", "reviewer-a", "reviewer-b"].map(id => find("fixture", id)!),
			stream: () => { throw new Error("Use simple"); },
			streamSimple: (model, context, options) => {
				requests.push({ id: model.id, context: JSON.parse(JSON.stringify(context)), display: footer?.render(400).join("\n") });
				if (requests.length > 80) throw new Error("Fixture detected an unbounded request loop");
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = { role: "assistant", api: "fixture", provider: "fixture", model: model.id,
					content: [], stopReason: "stop", timestamp: Date.now(), usage: usage() };
				if (model.id.startsWith("reviewer")) {
					if (mode === "slow" && model.id === "reviewer-b" || mode === "abort") {
						message.stopReason = "pending";
						billed.push(structuredClone(message.usage));
						stream.push({ type: "start", partial: message });
						options!.signal!.addEventListener("abort", () => { stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } }); stream.end(); }, { once: true });
						return stream;
					}
					if (mode === "failed") {
						message.stopReason = "error";
						message.errorMessage = "Fixture reviewer unavailable";
					} else {
						const lastUser = context.messages.findLastIndex(message => message.role === "user");
						const request = context.messages[lastUser];
						const revision = Number(JSON.stringify(request).match(/Review requested at revision (\d+)/)?.[1]);
						const tactical = context.tools?.every(tool => tool.name === "mixture_review");
						const read = context.messages.slice(lastUser + 1).findLast(message => message.role === "toolResult" && message.toolName === "read");
						if (!tactical && !read) message.content = tool("read", { path: "answer.ts" });
						else {
							const evidence = tactical ? JSON.stringify(context.messages) : JSON.stringify(read);
							message.content = tool("mixture_review", { revision, findings: evidence.includes("(x) => x;") ? [{ id: "negative-input", severity: "concern", summary: "Negative numbers remain negative", path: "answer.ts", evidence: "abs(-2) returns -2" }] : [] });
						}
					}
				} else if (model.id === "lead") {
					leadCalls++;
					if (leadCalls === 1) message.content = tool("mixture_control", { action: "delegate", task: "Implement abs in answer.ts", nextAction: "Write abs and verify negative inputs", constraints: ["Preserve the checkout"], successCriteria: ["abs(-2) is 2"] });
					else if (JSON.stringify(context.messages).includes("Negative numbers remain negative") && readFileSync(join(dir, "answer.ts"), "utf8") === bad) {
						const phaseId = JSON.stringify(context.messages).match(/Phase ID: ([\w-]+)/)?.[1];
						message.content = tool("mixture_control", correctionAssessed
							? { action: "delegate", phaseId, task: "Correct the negative-input defect in answer.ts", nextAction: "Negate negative inputs and verify abs(-2)", successCriteria: ["abs(-2) is 2"] }
							: { action: "assess", phaseId, assessment: "stalled", evidence: "Independent review and the file both show negative inputs remain negative" });
						correctionAssessed = true;
					}
					else message.content = [{ type: "text", text: "Implemented abs in answer.ts." }];
				} else {
					writerCalls++;
					const file = existsSync(join(dir, "answer.ts")) ? readFileSync(join(dir, "answer.ts"), "utf8") : undefined;
					if (!file) message.content = tool("write", { path: "answer.ts", content: mode === "correct" ? bad : good });
					else if (file === bad && JSON.stringify(context.messages).includes("Negative numbers remain negative")) message.content = tool("write", { path: "answer.ts", content: good });
					else if (mode === "correct" && writerCalls <= 3) message.content = tool("read", { path: "answer.ts" });
					else message.content = [{ type: "text", text: "Wrote answer.ts. Ready for lead review." }];
				}
				if (message.content.some(block => block.type === "toolCall")) message.stopReason = "toolUse";
				billed.push(structuredClone(message.usage));
				emitMessage(stream, message);
				return stream;
			},
		};
		const initialRegistry: Registry = { find, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }) };
		const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi: ExtensionAPI) => {
				pi.registerProvider(provider);
				pi.on("tool_result", event => { if (mode === "abort" && event.toolName === "write") void session!.abort(); });
			}, cleanFooter, (pi: ExtensionAPI) => createMixtureExtension(pi, initialRegistry)],
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "catalog"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
			sessionManager: SessionManager.inMemory(dir), modelRuntime: runtime, model: modelDefinition("default", preset, find), thinkingLevel: "high" }));
		const errors: unknown[] = [];
		await session.bindExtensions({ mode: "tui", onError: error => errors.push(error), uiContext: {
			notify() {}, setWorkingVisible() {},
			setStatus(key: string, value?: string) {
				if (value === undefined) statuses.delete(key); else statuses.set(key, value);
				if (footer) displays.push(footer.render(400).join("\n"));
			},
			setFooter(factory: any) {
				footer = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, { getExtensionStatuses: () => statuses });
			},
		} as any });
		expect(footer!.render(400).join("\n")).toContain("lead · idle · $0.000");
		await session.prompt("Implement abs in answer.ts, including negative inputs.");
		expect(errors).toEqual([]);
		expect(readFileSync(join(dir, "answer.ts"), "utf8")).toBe(good);
		const final = session.messages.at(-1) as AssistantMessage;
		if (mode === "abort") {
			expect(["aborted", "error"]).toContain(final.stopReason);
			expect(final.errorMessage).toContain("aborted");
		} else expect(final.stopReason).toBe("stop");
		if (mode !== "abort") {
			const firstReviewer = requests.findIndex(request => request.id.startsWith("reviewer"));
			expect(firstReviewer).toBeGreaterThanOrEqual(2);
			expect(requests.slice(0, firstReviewer).filter(request => request.id === "writer")).toHaveLength(mode === "correct" ? 4 : 2);
			const performance = session.messages.flatMap(message => message.role === "toolResult" ? [(message as any).details?.performanceStats] : []).filter(Boolean).at(-1);
			expect(performance.requests.writer.count).toBeGreaterThan(0);
			expect(performance.checkpoints["writer-report"].count).toBeGreaterThan(0);
		}
		if (mode === "correct") {
			expect(leadCalls).toBe(2);
			expect(JSON.stringify(requests.filter(request => request.id === "writer"))).toContain("Negative numbers remain negative");
		} else if (mode !== "abort") {
			expect(JSON.stringify(final.content)).toContain("Incomplete review");
			expect(JSON.stringify(final.content)).toContain(mode === "slow" ? "deadline" : "unavailable");
		}
		const total = emptyUsage(); for (const bill of billed) addUsage(total, bill);
		expect(session.getSessionStats().tokens.total).toBe(total.totalTokens);
		expect(session.getSessionStats().cost).toBeCloseTo(total.cost.total, 10);
		expect(sessionCost(session.sessionManager.getEntries())).toBeCloseTo(total.cost.total, 10);
		expect(displays.some(display => display.includes("lead · planning · $0.000"))).toBe(true);
		expect(displays.some(display => display.includes("writer · working · $"))).toBe(true);
		expect(footer!.render(400).join("\n")).toContain(`lead · idle · $${total.cost.total.toFixed(3)}`);
		expect(footer!.render(400).join("\n")).toContain("mixture/default | high");
		if (mode !== "abort") {
			expect(displays.some(display => display.includes("reviewer · reviewing · $"))).toBe(true);
			expect(displays.some(display => display.includes("lead · assessing · $"))).toBe(true);
		}
		if (mode === "correct") expect(requests.some(request => request.id.startsWith("reviewer") && request.display?.includes("writer · working"))).toBe(false);
		const noNestedUsage = structuredClone(session.messages) as Message[];
		for (const message of noNestedUsage) {
			if (message.role === "toolResult") delete message.usage;
			if (message.role === "assistant" && ["aborted", "error"].includes(message.stopReason)) message.usage = emptyUsage();
		}
		expect(getLastAssistantUsage(session.messages)).toEqual(getLastAssistantUsage(noNestedUsage));
	} finally {
		if (session) { await session.extensionRunner?.emit({ type: "session_shutdown" }); session.dispose(); }
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
