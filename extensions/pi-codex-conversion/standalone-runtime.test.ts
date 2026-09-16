import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { buildSessionContext, convertToLlm, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fixtureToken, summaryResponse, toolResponse } from "./native-response-fixture.ts";
import type { LocalContextState } from "./local-context.ts";
import { materializeStandaloneContext } from "./standalone-context.ts";

const entryType = "pi-codex-local-context-v1";

function materialize(entries: SessionEntry[]) {
	return materializeStandaloneContext(entries, convertToLlm(buildSessionContext(entries).messages), entryType)?.state;
}

function contextCheckpoints(entries: SessionEntry[]): Array<{ id: string; state: LocalContextState }> {
	return entries.flatMap((entry, index) => entry.type === "custom" && entry.customType === entryType && (entry.data as any)?.version !== 0
		? [{ id: entry.id, state: materialize(entries.slice(0, index + 1))! }]
		: []);
}

test("native standalone prompts preserve local windows through disk resume and tree navigation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-standalone-local-runtime-"));
	const agentDir = join(dir, "agent");
	const environment = new Map(["PI_CODING_AGENT_DIR", "XDG_CACHE_HOME"].map(key => [key, process.env[key]]));
	const requests: Array<{ body: any; headers: Headers; helper: boolean }> = [];
	const errors: unknown[] = [];
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const actions: Array<[string, Record<string, unknown>, string?]> = [
		["notes", { action: "write_file", path: "facts", text: "standalone-private" }],
		["new_context", {}],
		["notes", { action: "append_to_file", path: "facts", text: "-two" }],
		["new_context", {}],
		["notes", { action: "list_files_by_prefix", prefix: "" }],
		["notes", { action: "search_contents", query: "standalone-private" }],
		["notes", { action: "read_file", path: "facts" }],
		["get_context_remaining", {}],
		["history", { action: "list_windows" }],
		["history", { action: "list_items" }],
		["history", { action: "read_item" }],
		["history", { action: "search_contents", query: "standalone-private" }],
	];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const index = requests.length;
		const bytes = Buffer.from(await request.arrayBuffer());
		const encoding = request.headers.get("content-encoding");
		const body = JSON.parse((encoding === "gzip" ? gunzipSync(bytes) : encoding === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
		const helper = !body.tools?.length;
		requests.push({ body, headers: request.headers, helper });
		let action = actions[index];
		if (action?.[0] === "history" && action[1].action === "read_item") {
			const output = body.input.findLast((item: any) => item.type === "function_call_output").output;
			const item = JSON.parse(output).items[0];
			action = ["history", { action: "read_item", window_id: item.window_id, item_id: item.item_id }];
		}
		return new Response(action ? toolResponse(...action) : summaryResponse(helper ? "Native compaction summary sentinel." : "Completed without checkout changes."), { headers: { "content-type": "text/event-stream" } });
	};
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.XDG_CACHE_HOME = join(dir, "cache");
		await mkdir(agentDir);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, reserveTokens: 60_000 } }));
		await writeFile(join(agentDir, "pi-codex-conversion.json"), JSON.stringify({ executionMode: "normal", voiceFeaturesOnly: true,
			tools: { applyPatchOnly: false, viewImageOnly: false, autoReasoning: false },
			compaction: { contextManagement: "off", hybridCompaction: false, responsesCompaction: false } }));
		const callbacksPath = join(dir, "callbacks.ts");
		await writeFile(callbacksPath, `export default function(pi) {
			pi.on("before_provider_request", event => ({ ...event.payload, fixture_callback: "kept", ...(JSON.stringify(event.payload.input).includes("Reject this test request") ? { previous_response_id: "forbidden" } : {}) }));
			pi.on("before_provider_headers", event => { Object.assign(event.headers, { "x-codex-turn-state": "forbidden", "x-fixture-header": "kept" }); });
		}`);
		const open = async (manager: SessionManager) => {
			const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
			const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager,
				additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url)), callbacksPath],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await resourceLoader.reload();
			expect(resourceLoader.getExtensions().errors).toEqual([]);
			const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-cache"), allowModelNetwork: false });
			// Fake credentials only; native request preparation and callbacks still run.
			modelRuntime.hasConfiguredAuth = () => true;
			modelRuntime.getAuth = async () => ({ auth: { apiKey: fixtureToken, baseUrl: "https://fixture.invalid/backend-api" }, source: "fixture" });
			const created = await createAgentSession({ cwd: dir, agentDir, settingsManager, resourceLoader, sessionManager: manager, modelRuntime, model: modelRuntime.getModels("openai-codex")[0] });
			await created.session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
			return created.session;
		};
		session = await open(SessionManager.create(dir, join(dir, "sessions")));
		for (const name of ["history", "notes", "new_context", "get_context_remaining"]) expect(session.getActiveToolNames()).toContain(name);
		await session.prompt("Keep this current task through both windows.");
		const failure = session.agent.state.messages.findLast(message => message.role === "assistant" && message.stopReason === "error");
		if (failure?.role === "assistant") throw new Error(failure.errorMessage);
		expect(requests).toHaveLength(actions.length + 1);
		expect(errors).toEqual([]);
		expect(session.agent.state.messages.filter(message => message.role === "toolResult" && message.isError)).toEqual([]);
		const snapshots = contextCheckpoints(session.sessionManager.getBranch());
		const saved = snapshots.at(-1)!.state;
		expect(saved.archives).toHaveLength(2);
		expect(saved.notes[0].text).toBe("standalone-private-two");
		const remainingOutput = requests[8].body.input.findLast((item: any) => item.type === "function_call_output").output;
		expect(JSON.parse(remainingOutput)).toMatchObject({ contextWindow: 68_000 });
		expect(saved.archives[0].messages.filter(message => message.role === "user")).toHaveLength(1);
		for (const index of [2, 4]) expect(JSON.stringify(requests[index].body.input)).toContain("Keep this current task");
		expect(JSON.stringify(requests[2].body.input)).toContain("standalone-private");
		expect(JSON.stringify(requests[4].body.input)).toContain("standalone-private-two");
		const firstBranch = snapshots.findLast(snapshot => snapshot.state.archives.length === 1 && snapshot.state.notes[0]?.text === "standalone-private")!;
		expect(firstBranch).toBeDefined();
		const file = session.sessionManager.getSessionFile()!;
		await session.extensionRunner.emit({ type: "session_shutdown" });
		session.dispose(); session = undefined;

		session = await open(SessionManager.open(file));
		await session.prompt("Continue after disk resume.");
		expect(JSON.stringify(requests.at(-1)!.body.input)).toContain("standalone-private-two");
		const resumed = materialize(session.sessionManager.getBranch())!;
		expect(resumed.activeWindowId).toBe(saved.activeWindowId);
		expect(resumed.archives).toEqual(saved.archives);
		expect(resumed.activeItems.slice(0, saved.activeItems.length)).toEqual(saved.activeItems);
		expect((await session.navigateTree(firstBranch.id, { summarize: false })).cancelled).toBe(false);
		await session.prompt("Continue on the first branch.");
		expect(JSON.stringify(requests.at(-1)!.body.input)).toContain("standalone-private");
		expect(JSON.stringify(requests.at(-1)!.body.input)).not.toContain("standalone-private-two");
		expect(firstBranch.state.notes[0].text).toBe("standalone-private");
		expect(errors).toEqual([]);
		const requestsBeforeCompaction = requests.length;
		await session.compact("Preserve private facts.");
		const helpers = requests.slice(requestsBeforeCompaction);
		expect(helpers.length).toBeGreaterThan(0);
		expect(helpers.every(request => request.helper)).toBe(true);
		const compacted = materialize(session.sessionManager.getBranch())!;
		expect(compacted.archives).toHaveLength(2);
		expect(compacted.notes[0].text).toBe("standalone-private");
		await session.prompt("Continue after native compaction.");
		expect(JSON.stringify(requests.at(-1)!.body.input)).toContain("Native compaction summary sentinel.");
		expect(JSON.stringify(requests.at(-1)!.body.input)).toContain("standalone-private");
		const requestsBeforeRejection = requests.length;
		await session.prompt("Reject this test request.");
		expect(requests).toHaveLength(requestsBeforeRejection);
		const rejected = session.agent.state.messages.at(-1);
		expect(rejected).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: expect.stringContaining("prohibited field: previous_response_id") });
		for (const request of requests) {
			if (request.helper) expect(request.body.tools ?? []).toEqual([]);
			else {
				for (const name of ["read", "write", "edit", "bash", "history", "notes", "new_context", "get_context_remaining"]) expect(request.body.tools.map((tool: any) => tool.name)).toContain(name);
				expect(request.body.fixture_callback).toBe("kept");
				expect(request.headers.get("x-fixture-header")).toBe("kept");
			}
			expect(request.body.previous_response_id).toBeUndefined();
			expect(request.body.context_management).toBeUndefined();
			expect(request.body.store).toBe(false);
			expect(request.headers.has("x-codex-turn-state")).toBe(false);
			expect(request.headers.get("authorization")).toBe(`Bearer ${fixtureToken}`);
		}
	} finally {
		if (session) { await session.extensionRunner.emit({ type: "session_shutdown" }); session.dispose(); }
		globalThis.fetch = previousFetch;
		for (const [key, value] of environment) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);
