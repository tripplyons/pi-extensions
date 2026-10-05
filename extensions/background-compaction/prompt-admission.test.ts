import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import background from "./index.ts";
import { installPromptAdmission } from "./prompt-admission.ts";

const usage = (input: number) => ({ input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

test.each([
  { mode: "steer", prepared: false }, { mode: "followUp", prepared: false },
  { mode: "steer", prepared: true }, { mode: "followUp", prepared: true },
] as const)("pre-prompt compaction admits $mode input and notifications (prepared: $prepared)", async ({ mode, prepared }) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compaction-admission-"));
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, "auth.json"), refreshOnCreate: false });
  const model = { ...runtime.getModel("openai", "gpt-6.1-sol")!, contextWindow: 20_000 };
  let finishRequest!: () => void, started!: () => void, requests = 0, summaries = 0;
  const firstRequest = new Promise<void>(resolve => { started = resolve; });
  const provider: Provider = {
    id: "openai", name: "Fixture",
    auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key", source: "fixture" }),
      resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
    getModels: () => [model],
    stream: () => { throw new Error("Use streamSimple"); },
    streamSimple(model, context) {
      const summary = String(context.messages[0]?.content).includes("context summarization assistant");
      if (summary) summaries++; else requests++;
      const response: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
        timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: summary ? "Compacted seed." : "Done." }], usage: usage(100) };
      const stream = createAssistantMessageEventStream();
      const finish = () => { stream.push({ type: "done", reason: "stop", message: response }); stream.end(); };
      if (!summary && requests === 1) { finishRequest = finish; started(); }
      else finish();
      return stream;
    },
  };
  runtime.registerNativeProvider(provider);
  await runtime.setRuntimeApiKey("openai", "fixture");
  const manager = SessionManager.inMemory(dir);
  for (let i = 0; i < 10; i++) manager.appendMessage(i % 2 === 0
    ? { role: "user", content: `Seed ${i}`.padEnd(4_000, "x"), timestamp: Date.now() }
    : { role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
      stopReason: i === 9 && !prepared ? "aborted" : "stop", content: [{ type: "text", text: `Seed ${i}`.padEnd(4_000, "x") }], usage: usage(i === 9 ? 19_500 : 0) });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, extensionFactories: [background, pi => {
      pi.on("input", event => event.text === "Handled input." ? { action: "handled" } : undefined);
      pi.registerCommand("resume", { description: "Resume fixture", handler: async () => { await session.prompt("Continue after abort."); } });
    }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model,
    resourceLoader: loader, sessionManager: manager, noTools: true,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 3_000 } }) });
  const queued: Promise<unknown>[] = [], errors: string[] = [];
  let queueFlushed = false;
  const track = (promise: Promise<unknown>) => queued.push(promise.catch(error => { errors.push(String(error)); }));
  try {
    await session.bindExtensions({ mode: "print", onError: event => errors.push(event.error) });
    await session.prompt("Handled input.");
    expect(requests).toBe(0);
    if (prepared) {
      await session.extensionRunner.emit({ type: "turn_end", turnIndex: 0,
        message: manager.buildSessionContext().messages.at(-1) as AssistantMessage, toolResults: [] });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(summaries).toBe(1);
    }
    session.subscribe(event => {
      if (event.type !== "compaction_end" || queueFlushed) return;
      queueFlushed = true;
      // Match InteractiveMode.flushCompactionQueue and a simultaneous extension wakeup.
      track(session.prompt("Queued during compaction.", { streamingBehavior: mode }));
      track(session.sendUserMessage("Extension wakeup.", { deliverAs: "steer" }));
      track(session.sendCustomMessage({ customType: "pi-task-completed", content: "Task finished.", display: true, details: {} },
        { triggerTurn: true, deliverAs: "steer" }));
    });
    track(session.prompt(mode === "followUp" ? "/resume" : "Continue after abort."));
    await firstRequest;
    // Let the admitted inputs reach Pi's queues before finishing the first response.
    await new Promise(resolve => setTimeout(resolve, 0));
    finishRequest();
    await Promise.all(queued);
    await session.waitForIdle();
    expect(queueFlushed).toBe(true);
    expect(summaries).toBeGreaterThan(0);
    const compactions = manager.getBranch().filter(entry => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0].fromHook).toBe(prepared);
    expect(errors).toEqual([]);
    for (const text of ["Continue after abort.", "Queued during compaction.", "Extension wakeup."]) {
      expect(session.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes(text))).toHaveLength(1);
    }
    expect(session.messages.filter(message => message.role === "custom" && message.customType === "pi-task-completed")).toHaveLength(1);
    expect(requests).toBeGreaterThan(1);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("admission restores prototypes only after the last owner shuts down", () => {
  const prompt = AgentSession.prototype.prompt, custom = AgentSession.prototype.sendCustomMessage;
  const first = installPromptAdmission(), second = installPromptAdmission();
  const guarded = AgentSession.prototype.prompt;
  expect(guarded).not.toBe(prompt);
  first(); first();
  expect(AgentSession.prototype.prompt).toBe(guarded);
  second();
  expect(AgentSession.prototype.prompt).toBe(prompt);
  expect(AgentSession.prototype.sendCustomMessage).toBe(custom);
});
