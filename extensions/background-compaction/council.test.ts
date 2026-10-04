import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import council from "../council/index.ts";
import presentation from "../presentation/index.ts";
import background from "./index.ts";

test("Council prepares and applies a background summary, renders its state, and preserves routing state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-council-background-"));
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, "auth.json"), refreshOnCreate: false });
  let advisors = 0, executors = 0, summaries = 0;
  const usage = (input: number) => ({ input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  for (const id of ["openai", "anthropic"]) {
    const models = runtime.getModels(id).filter(model => ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5"].includes(model.id))
      .map(model => ({ ...model, contextWindow: 20_000 }));
    const provider: Provider = {
      id, name: id,
      auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key", source: "fixture" }),
        resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
      getModels: () => models,
      stream: () => { throw new Error("Use streamSimple"); },
      streamSimple(model, context, options) {
        const prompt = String(context.messages[0]?.content);
        const isAdvisor = prompt.includes("independent advisor");
        const isSummary = prompt.includes("context summarization assistant");
        if (isAdvisor) advisors++;
        else if (isSummary) {
          summaries++;
          expect(model.id).toBe("gpt-6.1-sol");
          expect(options?.reasoning).toBe("medium");
          expect(JSON.stringify(context.messages)).not.toContain("Synthesize the three advisory answers");
        } else {
          executors++;
          expect(JSON.stringify(context.messages.at(-1))).toContain("Synthesize the three advisory answers");
        }
        const response: AssistantMessage = {
          role: "assistant", provider: id, model: model.id, api: model.api, timestamp: Date.now(),
          stopReason: "stop", content: [{ type: "text", text: isSummary ? "Prepared background summary." : isAdvisor ? "Answer the user and stop." : "Done." }],
          usage: usage(isAdvisor || isSummary ? 10 : executors === 1 ? 12_000 : 5_000),
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: response }); stream.end();
        return stream;
      },
    };
    runtime.registerNativeProvider(provider);
    await runtime.setRuntimeApiKey(id, "fixture");
  }
  const manager = SessionManager.inMemory(dir);
  for (let i = 0; i < 10; i++) {
    manager.appendMessage(i % 2 === 0 ? { role: "user", content: `Seed ${i}: `.padEnd(4_000, "x"), timestamp: Date.now() }
      : { role: "assistant", provider: "openai", model: "gpt-6.1-sol", api: "openai-responses", timestamp: Date.now(),
        stopReason: "stop", content: [{ type: "text", text: `Seed ${i}: `.padEnd(4_000, "x") }], usage: usage(0) });
  }
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [council, presentation, background],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime: runtime, resourceLoader: loader, sessionManager: manager, noTools: true,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false },
      compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 3_000 } }),
  });
  const statuses = new Map<string, string>(), errors: string[] = [], notices: string[] = [];
  let footer: any;
  try {
    await session.bindExtensions({ mode: "print", onError: event => errors.push(event.error), uiContext: {
      setStatus(key: string, value?: string) { if (value) statuses.set(key, value); else statuses.delete(key); },
      notify(text: string) { notices.push(text); },
      setToolsExpanded() {}, setTitle() {}, setWorkingIndicator() {}, setWorkingVisible() {},
      setFooter(factory: any) {
        footer = factory?.({}, { fg: (_color: string, text: string) => text }, { getExtensionStatuses: () => statuses });
      },
    } as any });
    await session.setModel(runtime.getModel("tripp", "council")!);
    expect(footer.render(60)[0]).toContain("background: waiting");
    expect(footer.render(60)[0]).not.toContain("medium");
    await session.prompt("Finish the seeded task.");
    // The summarizer runs outside the agent loop; let its terminal result settle.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(summaries).toBe(1);
    expect(advisors).toBe(3);
    expect(statuses.get("background-compaction")).toBe("background: ready");
    expect(footer.render(60)[0]).toContain("background: ready");
    const routerState = () => (manager.getBranch().findLast(entry => entry.type === "custom" &&
      entry.customType === "pi.virtual-model-state") as any).data.state;
    const before = structuredClone(routerState());
    const compacted = await session.compact();
    expect(compacted.summary).toContain("Prepared background summary.");
    expect(summaries).toBe(1);
    expect(advisors).toBe(3);
    expect(routerState()).toEqual(before);
    expect(manager.getBranch().findLast(entry => entry.type === "compaction")).toMatchObject({ fromHook: true });
    expect(footer.render(60)[0]).toContain("background: waiting");
    await session.prompt("Answer briefly using the compacted context.");
    expect(advisors).toBe(6);
    expect(executors).toBe(2);
    expect(routerState().round).toBe(2);
    expect(summaries).toBe(1);
    expect(errors).toEqual([]);
    expect(notices).toEqual([]);
  } finally { session.dispose(); await rm(dir, { recursive: true, force: true }); }
});
