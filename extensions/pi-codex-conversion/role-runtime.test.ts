import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { defaultConfig } from "../mixture/config.ts";
import { restoreCheckpoint } from "../mixture/checkpoint.ts";
import { requestLaneId } from "../mixture/provider.ts";
import { provisionOfflineWorker } from "./worker-runtime-fixture.ts";

import { fixtureToken as token, summaryResponse, toolResponse } from "./native-response-fixture.ts";

const cases: Array<{ reviewerCount: number; worker?: boolean; overflow?: boolean }> = [
	...[0, 1, 4].map(reviewerCount => ({ reviewerCount })),
	{ reviewerCount: 4, worker: true }, { reviewerCount: 4, overflow: true },
];
for (const { reviewerCount, worker = false, overflow = false } of cases) test(`${worker ? "Swarm worker" : "registered Mixture"} runtime isolates local windows with ${reviewerCount} reviewers${overflow ? " and role overflow recovery" : ""}`, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-local-role-runtime-"));
	let agentDir = join(dir, "agent");
	let cwd = dir;
	const environmentKeys = ["PI_CODING_AGENT_DIR", "PI_SWARM_HOME", "PI_SWARM_WORKER", "PI_SWARM_RUN", "PI_SWARM_NODE", "PI_SWARM_TOKEN", "PI_SWARM_FAST", "XDG_CACHE_HOME", "PI_COMPLAIN_LOG"];
	const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
	let workerFixture: Awaited<ReturnType<typeof provisionOfflineWorker>> | undefined;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const requests: Array<{ role: string; body: any; headers: Headers; summary: boolean; failed: boolean }> = [];
	const failedActors = new Set<string>();
	const stages = new Map<string, number>();
	const eventBus = createEventBus();
	const releasedIds: string[] = [];
	eventBus.on("tripp:mixture-session-release/v1", value => releasedIds.push(...(value as { sessionIds: string[] }).sessionIds));
	const reviewersReady = Promise.withResolvers<void>();
	let reviewerStarts = 0;
	let payloadCalls = 0;
	let responseCalls = 0;
	const server = Bun.serve({ port: 0, async fetch(request) {
		const bytes = new Uint8Array(await request.arrayBuffer());
		const decoded = request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes;
		const body = JSON.parse(new TextDecoder().decode(decoded));
		const instructions = body.instructions ?? body.messages?.filter((message: any) => ["system", "developer"].includes(message.role)).map((message: any) => message.content).join("\n") ?? "";
		const reply = (name: string, args: Record<string, unknown>, namespace?: string) => toolResponse(name, args, namespace, !!body.messages);
		const role = /ROLE_REVIEWER_(\d+)/.exec(instructions)?.[1];
		const summary = !(body.tools?.length);
		const actor = summary ? /((?:lead|writer|reviewer-\d+))-private-sentinel/.exec(JSON.stringify(body.input ?? body.messages))?.[1] ?? "unknown-summary"
			: role ? `reviewer-${role}` : instructions.includes("You are the writer, not the lead") ? "writer" : "lead";
		const stage = stages.get(actor) ?? 0;
		const failed = overflow && !summary && stage === 4 && !failedActors.has(actor);
		requests.push({ role: actor, body, headers: request.headers, summary, failed });
		if (summary) return new Response(summaryResponse(), { headers: { "content-type": "text/event-stream" } });
		if (failed) {
			failedActors.add(actor);
			return new Response(`data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", output: [], error: { code: "context_length_exceeded", message: "maximum context length exceeded" }, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
		}
		stages.set(actor, stage + 1);
		if (actor.startsWith("reviewer-") && stage === 0) {
			if (++reviewerStarts === reviewerCount) reviewersReady.resolve();
			await reviewersReady.promise;
		}
		let response: string;
		if (stage === 0) response = reply("write_file", { path: "facts", text: `${actor}-private-sentinel` }, "notes");
		else if (stage === 1) response = reply("append_to_file", { path: "facts", text: "-appended" }, "notes");
		else if (stage === 2) response = reply("list_files_by_prefix", { prefix: "" }, "notes");
		else if (stage === 3) response = reply("search_contents", { query: `${actor}-private-sentinel` }, "notes");
		else if (stage === 4) response = reply("read_file", { path: "facts" }, "notes");
		else if (stage === 5) response = reply("get_context_remaining", {});
		else if (stage === 6 || stage === 11) response = reply("new_context", {});
		else if (stage === 7) response = reply("list_windows", {}, "history");
		else if (stage === 8) response = reply("list_items", {}, "history");
		else if (stage === 9) {
			const last = body.input?.findLast((item: any) => item.type === "function_call_output") ?? body.messages?.findLast((item: any) => item.role === "tool");
			const raw = last.output ?? last.content;
			const result = JSON.parse(typeof raw === "string" ? raw : raw.map((item: any) => item.text).join(""));
			const item = result.items[0];
			response = reply("read_item", { window_id: item.window_id, item_id: item.item_id }, "history");
		}
		else if (stage === 10) response = reply("search_contents", { query: `${actor}-private-sentinel` }, "history");
		else if (actor === "lead") response = reply("mixture_control", { action: "delegate", task: "Record private context facts without checkout changes", nextAction: "Write private notes and switch windows twice", successCriteria: ["Private context is retained"] });
		else if (actor === "writer") response = reply("mixture_control", { action: "report", report: "Private context recorded; no checkout changes." });
		else {
			const text = JSON.stringify(body.input);
			const revision = Number(/revision[\\" :]*(\d+)/i.exec(text)?.[1] ?? 0);
			response = reply("mixture_review", { revision, findings: [] });
		}
		return new Response(response, { headers: { "content-type": "text/event-stream" } });
	} });
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_SWARM_WORKER;
		process.env.PI_SWARM_HOME = join(dir, "swarm");
		process.env.XDG_CACHE_HOME = join(dir, "cache");
		process.env.PI_COMPLAIN_LOG = join(dir, "complaints.log");
		await mkdir(agentDir);
		const preset = structuredClone(defaultConfig().presets.default);
		if (overflow) preset.writer.model = preset.lead;
		preset.reviewers = Array.from({ length: reviewerCount }, (_, index) => ({ model: preset.lead, thinking: "low" as const, guidance: `ROLE_REVIEWER_${index + 1}` }));
		preset.limits.reviewerBatchTurns = 16;
		await writeFile(join(agentDir, "mixture.json"), JSON.stringify({ version: 3, presets: { fixture: preset } }));
		await writeFile(join(agentDir, "pi-codex-conversion.json"), JSON.stringify({ voiceFeaturesOnly: true, compaction: { contextManagement: "off", hybridCompaction: false, responsesCompaction: false } }));
		if (worker) {
			await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: token }, openrouter: { type: "api_key", key: "fixture" } }));
			workerFixture = await provisionOfflineWorker(dir);
			agentDir = workerFixture.agentDir;
			cwd = workerFixture.cwd;
			for (const key of environmentKeys) if (workerFixture.environment[key] !== undefined) process.env[key] = workerFixture.environment[key];
		}
		const settingsManager = SettingsManager.inMemory(worker ? JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) : { packages: [] });
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus,
			additionalExtensionPaths: workerFixture?.extensions ?? ["./index.ts", "../mixture/index.ts"].map(path => fileURLToPath(new URL(path, import.meta.url))),
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: SessionManager.inMemory(cwd), model: modelRuntime.getModels("openai-codex")[0] }));
		const errors: unknown[] = [];
		await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
		const registry = session.extensionRunner.createCommandContext().modelRegistry;
		registry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: token, baseUrl: `http://127.0.0.1:${server.port}` });
		const model = registry.find("mixture", "fixture")!;
		expect(model).toBeDefined();
		await session.setModel(model);
		const prompt = "Record private context facts without checkout changes";
		const started = await session.extensionRunner.emitBeforeAgentStart(prompt, undefined, "Offline fixture", { cwd });
		if (worker) expect(session.getActiveToolNames()).toContain("swarm_task");
		const messages: Message[] = [{ role: "user", content: prompt, timestamp: 1 }];
		const provider = registry.getProvider("mixture")!;
		for (let turn = 0; turn < 26; turn++) {
			const message = await provider.streamSimple(model, { systemPrompt: started?.systemPrompt ?? "Offline fixture", messages, tools: session.agent.state.tools }, {
				sessionId: session.sessionManager.getSessionId(), reasoning: "high",
				onPayload: async body => {
					payloadCalls++; (body as any).fixture_callback = "preserved";
					return session!.extensionRunner.emitBeforeProviderRequest(body);
				},
				onResponse: () => { responseCalls++; },
			}).result();
			if (message.stopReason === "error") throw new Error(`Turn ${turn}: ${message.errorMessage}\n${JSON.stringify(messages.slice(-4))}\nRequests: ${requests.map(request => request.role).join(", ")}`);
			expect(message.stopReason).toBe("toolUse");
			messages.push(message);
			const results: ToolResultMessage[] = [];
			for (const call of message.content.filter(block => block.type === "toolCall")) {
				const tool = session.agent.state.tools.find(tool => tool.name === call.name)!;
				expect(tool).toBeDefined();
				const result = await tool.execute(call.id, call.arguments, new AbortController().signal);
				results.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, ...result, isError: false, timestamp: Date.now() });
			}
			messages.push(...results);
			await session.extensionRunner.emit({ type: "turn_end", message, toolResults: results } as any);
		}
		expect(errors).toEqual([]);
		expect(payloadCalls).toBe(requests.length);
		expect(responseCalls).toBe(requests.length);
		expect(reviewerStarts).toBe(reviewerCount);
		if (worker) expect(await readFile(join(cwd, "fixture.txt"), "utf8")).toBe("checkout-sentinel\n");
		const restored = restoreCheckpoint(session.sessionManager.getBranch(), session.sessionManager.getEntries(), "fixture", preset, cwd);
		expect(restored.state).toBeDefined();
		const roles = [restored.state!.lead, restored.state!.writer, ...restored.state!.reviewers];
		for (const [index, role] of roles.entries()) {
			const actor = index === 0 ? "lead" : index === 1 ? "writer" : `reviewer-${index - 1}`;
			expect(role.localContext!.notes[0]?.text).toBe(`${actor}-private-sentinel-appended`);
			expect(role.localContext!.archives.length).toBeGreaterThanOrEqual(2);
			expect(role.calls).toBe(requests.filter(request => request.role === actor).length);
			expect(role.usage.input).toBe(requests.filter(request => request.role === actor && !request.failed).length * 7);
			if (overflow) {
				expect(requests.filter(request => request.role === actor && request.summary)).toHaveLength(1);
				expect(role.summaries).toBe(1);
				const actorRequests = requests.filter(request => request.role === actor);
				const summaryIndex = actorRequests.findIndex(request => request.summary);
				expect(new Set([actorRequests[0], actorRequests[summaryIndex], actorRequests[summaryIndex + 1]].map(request => request.headers.get("session-id"))).size).toBe(3);
			}
			for (const other of roles.filter(other => other !== role)) expect(JSON.stringify(other.localContext!.notes)).not.toContain(`${actor}-private-sentinel`);
		}
		for (const request of requests) {
			expect(request.body.fixture_callback).toBe("preserved");
			if (request.summary) expect(request.body.tools ?? []).toEqual([]);
			else for (const name of ["history", "notes", "new_context", "get_context_remaining"]) expect(JSON.stringify(request.body.tools)).toContain(`"name":"${name}"`);
			for (const actor of stages.keys()) if (actor !== request.role) expect(JSON.stringify(request.body.input ?? request.body.messages)).not.toContain(`${actor}-private-sentinel`);
			if (worker) expect(request.body.service_tier).toBe("default");
			if (request.role === "writer" && !overflow) {
				expect(JSON.stringify(request.body.tools)).not.toContain('"name":"swarm_task"');
				expect(request.body.messages).toBeDefined();
				expect(request.body.input).toBeUndefined();
				expect(request.body.tools.some((tool: any) => tool.type === "namespace")).toBe(false);
			}
			expect(request.body.previous_response_id).toBeUndefined();
			expect(request.body.compaction_trigger).toBeUndefined();
			expect(request.headers.has("x-codex-turn-state")).toBe(false);
		}
		const ended = { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] } as any;
		await session.extensionRunner.emit(ended);
		const expectedIds = [...stages.keys()].flatMap(actor => (overflow ? ["ordinary", "summary", "overflow"] as const : ["ordinary"] as const)
			.map(lane => requestLaneId(session!.sessionManager.getSessionId(), restored.state!.id, actor, lane)));
		expect([...releasedIds].sort()).toEqual(expectedIds.sort());
		await session.extensionRunner.emit(ended);
		expect(releasedIds).toHaveLength(expectedIds.length);
	} finally {
		reviewersReady.resolve();
		if (session) { await session.extensionRunner.emit({ type: "session_shutdown" }); session.dispose(); }
		server.stop(true);
		try { await workerFixture?.close(); }
		finally {
			for (const [key, value] of previousEnvironment) if (value === undefined) delete process.env[key]; else process.env[key] = value;
			await rm(dir, { recursive: true, force: true });
		}
	}
}, 30_000);
