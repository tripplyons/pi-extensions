import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
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
