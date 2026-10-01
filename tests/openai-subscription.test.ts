import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Provider } from "@earendil-works/pi-ai";
import guard from "../extensions/openai-subscription/index.ts";

test("the real SDK installs guards on startup and blocks resolved API keys and configured billing headers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subscription-"));
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => { fetches++; throw new Error("A request must not reach the network"); }) as typeof fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-synthetic-env";
  try {
    const modelsPath = join(dir, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { openai: {
      headers: { Authorization: "Bearer sk-synthetic-header" },
    } } }));
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath, modelsStorePath: join(dir, "cache.json"),
      refreshOnCreate: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, extensionFactories: [guard],
    });
    await loader.reload();
    const model = modelRuntime.getModel("openai", "gpt-6.1-sol")!;
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime, model,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
      resourceLoader: loader, sessionManager: SessionManager.inMemory(dir),
    });
    try {
      const errors: string[] = [];
      await session.bindExtensions({ onError: event => errors.push(event.error) });
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getExtensions().extensions).toHaveLength(1);
      expect(errors).toEqual([]);
      for (const options of [undefined, { apiKey: "sk-synthetic-explicit" }]) {
        const result = await modelRuntime.completeSimple(model, { messages: [] }, options);
        expect(result.stopReason).toBe("error");
      }
      expect(fetches).toBe(0);
      // This is the same runtime used by compaction and codemode model calls.
      await modelRuntime.setRuntimeApiKey("openai", "sk-synthetic-runtime");
      expect((await modelRuntime.completeSimple(model, { messages: [] })).stopReason).toBe("error");
      expect(fetches).toBe(0);
    } finally { session.dispose(); }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["openai", "openai-codex"])("native compaction reuses verified %s OAuth without an API-key fallback", async providerId => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compaction-subscription-"));
  const access = "synthetic-compaction-oauth";
  const credential = {
    type: "oauth", access, refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000, scopes: ["chatgpt.tokens.use.direct"],
  };
  let requests = 0;
  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ [providerId]: credential }));
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "cache.json"), refreshOnCreate: false,
    });
    const model = runtime.getModel(providerId, "gpt-6.1-sol")!;
    const original = runtime.getProvider(providerId)!;
    const stream: Provider["streamSimple"] = (requestModel, _context, options) => {
      expect(options?.apiKey).toBe(access);
      expect(options?.cacheRetention).toBe("none");
      requests++;
      const response: any = {
        role: "assistant", provider: providerId, model: requestModel.id, api: requestModel.api,
        content: [{ type: "text", text: "Verified synthetic compaction summary" }],
        timestamp: Date.now(), stopReason: "stop",
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const result = createAssistantMessageEventStream();
      result.push({ type: "done", reason: "stop", message: response });
      result.end();
      return result;
    };
    const provider: Provider = {
      ...original,
      auth: { oauth: {
        ...original.auth.oauth!,
        toAuth: async value => ({ apiKey: value.access }),
      } },
      stream: stream as Provider["stream"], streamSimple: stream,
    };
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true,
      extensionFactories: [pi => { pi.registerProvider(provider); }, guard],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendModelChange(providerId, model.id);
    manager.appendMessage({ role: "user", content: "Summarize this completed task.", timestamp: 1 });
    manager.appendMessage({
      role: "assistant", provider: providerId, model: model.id, api: model.api,
      content: [{ type: "text", text: "Completed task evidence. ".repeat(200) }],
      timestamp: 2, stopReason: "stop",
      usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime: runtime, model, resourceLoader: loader,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, keepRecentTokens: 0 }, retry: { enabled: false }, cacheWarming: "off",
      }),
      sessionManager: manager,
    });
    try {
      const errors: string[] = [];
      await session.bindExtensions({ onError: event => errors.push(event.error) });
      expect(errors).toEqual([]);
      const result = await session.compact();
      expect(result.summary).toContain("Verified synthetic compaction summary");
      expect(requests).toBeGreaterThan(0);
      expect(manager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
      const blocked = await runtime.completeSimple(model, { messages: [] }, { apiKey: "sk-synthetic" });
      expect(blocked.stopReason).toBe("error");
      expect(blocked.errorMessage).toContain("API billing is disabled");
    } finally { session.dispose(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
