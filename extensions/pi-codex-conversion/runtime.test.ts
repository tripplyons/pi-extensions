import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalContext } from "./local-context.ts";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("native runtime preserves file tools and executes bg-bash in an isolated Pi session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-code-runtime-"));
  const agentDir = join(dir, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousCache = process.env.XDG_CACHE_HOME;
  let session;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "pi-codex-conversion.json"), JSON.stringify({
      executionMode: "normal",
      voiceFeaturesOnly: true,
      tools: { applyPatchOnly: false, viewImageOnly: false, autoReasoning: false },
      compaction: { contextManagement: "off", hybridCompaction: false, responsesCompaction: false },
    }));
    const addons = process.env.PI_CODE_ADDON_DIR
      ? ["pi-codex-web-run", "pi-codex-imagegen"].map((name) => join(process.env.PI_CODE_ADDON_DIR!, "node_modules/@howaboua", name))
      : [];
    await mkdir(join(dir, ".auto"));
    await writeFile(join(dir, ".auto/log.jsonl"), JSON.stringify({ type: "config", name: "Code smoke", metricName: "runtime_ms", metricUnit: "ms", bestDirection: "lower" }) + "\n");
    const settingsManager = SettingsManager.inMemory({ packages: addons });
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir, settingsManager,
      additionalExtensionPaths: ["./index.ts", "../bg-bash/index.ts", "../ask-user/index.ts", "../subagent/index.ts", "../tripp-autoresearch/index.ts", "../mixture/index.ts"].map((path) => fileURLToPath(new URL(path, import.meta.url))),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models-cache"), allowModelNetwork: false,
    });
    const sessionManager = SessionManager.inMemory(dir);
    sessionManager.appendCustomEntry("codex-context-note", { protocol: 1, action: "write", path: "/root/notes/legacy", text: "old-upstream-note-sentinel", timestamp: Date.now() });
    ({ session } = await createAgentSession({
      cwd: dir, agentDir, settingsManager, resourceLoader,
      sessionManager,
      modelRuntime,
      model: modelRuntime.getModels("openai-codex")[0],
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
    expect(errors).toEqual([]);
    const names = session.getActiveToolNames();
    for (const name of ["read", "write", "edit", "bash", "bg_process", "sleep", "ask_user", "subagent_process"]) expect(names).toContain(name);
    for (const name of ["exec", "wait", "apply_patch", "exec_command", "read_file", "ask"]) expect(names).not.toContain(name);
    for (const name of ["history", "notes", "new_context", "get_context_remaining"]) expect(names).toContain(name);
    const call = (name: string, args: any) => session.agent.state.tools.find((tool) => tool.name === name)!.execute(name, args, new AbortController().signal);
    await call("write", { path: "smoke.txt", content: "before\n" });
    await call("edit", { path: "smoke.txt", edits: [{ oldText: "before", newText: "after" }] });
    expect(await readFile(join(dir, "smoke.txt"), "utf8")).toBe("after\n");
    expect(JSON.stringify((await call("read", { path: "smoke.txt" })).content)).toContain("after");
    expect(JSON.stringify((await call("subagent_process", { action: "list" })).content)).toContain("No subagent jobs");
    const mixture = resourceLoader.getExtensions().extensions.find(extension => extension.commands.has("mixture"))!.commands.get("mixture")!;
    const commandContext = session.extensionRunner.createCommandContext();
    const localStatus = resourceLoader.getExtensions().extensions.find(extension => extension.commands.has("codex-local"))!.commands.get("codex-local")!;
    const diagnostics: string[] = [];
    await localStatus.handler("", { ...commandContext, ui: { ...commandContext.ui, notify: (text: string) => diagnostics.push(text) } });
    expect(JSON.parse(diagnostics[0])).toMatchObject({ codexTransport: "sse", activeCodexRequests: 0, role: "/root", noteFiles: 0 });
    expect(JSON.stringify(session.sessionManager.getEntries())).toContain("old-upstream-note-sentinel");
    const toolsBeforeStatus = session.getActiveToolNames();
    await mixture.handler("status", commandContext);
    expect(session.getActiveToolNames()).toEqual(toolsBeforeStatus);
    for (const name of ["mixture_control", "mixture_run", "mixture_process"]) expect(session.getActiveToolNames()).not.toContain(name);
    expect(session.getActiveToolNames()).toContain("run_experiment");
    if (addons.length) for (const name of ["web_run", "imagegen"]) expect(session.getActiveToolNames()).toContain(name);

    // Exercise the registered provider, including policy re-read on dispatch.
    let requests = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      requests++;
      return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n', { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const provider = commandContext.modelRegistry.getProvider("openai-codex")!;
      const model = { ...commandContext.model!, baseUrl: "https://fixture.invalid" };
      const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.test`;
      const configPath = join(agentDir, "pi-codex-conversion.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      for (const override of [
        { compaction: { contextManagement: "remote" } },
        { openai: { forceCachedWebSockets: true } },
        { openai: { proxyResponsesLite: true } },
        { openai: { cacheKeepalive: true } },
      ]) {
        await writeFile(configPath, JSON.stringify({ ...config, ...override }));
        const result = await provider.streamSimple(model, { messages: [] }, { apiKey: token, maxRetries: 0 }).result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toContain("refused incompatible settings");
      }
      expect(requests).toBe(0);
      await writeFile(configPath, JSON.stringify(config));
      const result = await provider.streamSimple(model, { messages: [] }, { apiKey: token, maxRetries: 0 }).result();
      expect(result.stopReason).toBe("stop");
      expect(requests).toBe(1);
      for (const type of ["agent_end", "model_select", "session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact"]) {
        const ready = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const pending = provider.streamSimple(model, { messages: [] }, {
          apiKey: token, sessionId: `fixture/${type}`, maxRetries: 0,
          onPayload: async () => { ready.resolve(); await resume.promise; },
        });
        await ready.promise;
        await session.extensionRunner.emit({ type } as any);
        resume.resolve();
        expect((await pending.result()).stopReason).toBe("aborted");
        expect(requests).toBe(1);
      }
      const validLeaf = session.sessionManager.getBranch().at(-1)!.id;
      for (const invalidState of [
        { version: 1, notes: "malformed-sentinel" },
        createLocalContext({ branchId: "fixture", preset: "standalone-codex", role: "writer" }),
      ]) {
        session.sessionManager.appendCustomEntry("pi-codex-local-context-v1", invalidState);
        const entriesBefore = session.sessionManager.getEntries().length;
        await session.extensionRunner.emit({ type: "session_tree" } as any);
        expect(session.sessionManager.getEntries()).toHaveLength(entriesBefore);
        const rejected = await provider.streamSimple(model, { messages: [] }, { apiKey: token, maxRetries: 0 }).result();
        expect(rejected.stopReason).toBe("error");
        expect(rejected.errorMessage).toContain("stored entry was not changed");
        expect(requests).toBe(1);
      }
      session.sessionManager.branch(validLeaf);
      await session.extensionRunner.emit({ type: "session_tree" } as any);
      const ready = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const pending = provider.streamSimple(model, { messages: [] }, { apiKey: token, maxRetries: 0,
        onPayload: async () => { ready.resolve(); await resume.promise; },
      });
      await ready.promise;
      await session.extensionRunner.emit({ type: "session_shutdown" });
      resume.resolve();
      expect((await pending.result()).stopReason).toBe("aborted");
      expect(requests).toBe(1);
    } finally { globalThis.fetch = previousFetch; }

  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
