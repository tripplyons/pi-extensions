import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import council, { TURN_BUDGET } from "./index.ts";

test.each([{ id: "council", count: 3 }, { id: "council-openai", count: 2 }])(
  "$id handles real SDK swarm wake-ups without consulting or spending work slots",
  async ({ id: modelId, count }) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-council-notifications-"));
    const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, "auth.json"), refreshOnCreate: false });
    let advisors = 0, executors = 0, workTurns = 0;
    let phase = "notification";
    const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    for (const id of modelId === "council-openai" ? ["openai"] : ["openai", "anthropic"]) {
      const models = runtime.getModels(id).filter(model => ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5"].includes(model.id));
      const provider: Provider = {
        id, name: id,
        auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key", source: "fixture" }),
          resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
        getModels: () => models,
        stream: () => { throw new Error("Use streamSimple"); },
        streamSimple(model, context) {
          const advisor = String(context.messages[0]?.content).includes("independent advisor");
          if (advisor) advisors++;
          else {
            executors++;
            if (phase === "work") workTurns++;
            const internal = context.messages.filter(message => message.role === "system" &&
              String(message.content).startsWith("Internal Council guidance"));
            expect(internal).toHaveLength(advisors / count);
            if (internal.length) {
              expect(internal[0].content).toContain("Current swarm messages");
              expect(internal[0].content).toContain("not a live status report");
            }
            // Only genuine inputs and custom notifications can become provider-visible user messages.
            expect(context.messages.filter(message => message.role === "user").some(message =>
              JSON.stringify(message.content).includes("Internal Council guidance"))).toBe(false);
          }
          const message: AssistantMessage = { role: "assistant", api: model.api, provider: id, model: model.id,
            stopReason: "stop", timestamp: Date.now(), usage,
            content: [{ type: "text", text: advisor ? "Use current evidence; do not reopen completed work." : "Handled." }] };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: "stop", message }); stream.end();
          return stream;
        },
      };
      runtime.registerNativeProvider(provider);
      await runtime.setRuntimeApiKey(id, "fixture");
    }
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [council, pi => {
        pi.on("turn_end", () => {
          if (phase !== "work" || workTurns >= TURN_BUDGET) return;
          return { entries: [{ type: "custom_message", customType: "test-work", content: "Continue the bounded task.", display: false }], continue: true };
        });
      }],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime: runtime, resourceLoader: loader, sessionManager: manager, noTools: "all",
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    });
    const errors: string[] = [];
    const notify = () => session.sendCustomMessage({ customType: "swarm-message",
      content: "Worker progress remains visible.", display: true, details: { kind: "message", from: "fixture-worker" } },
      { triggerTurn: true, deliverAs: "steer" });
    const state = () => (manager.getBranch().findLast(entry => entry.type === "custom" &&
      entry.customType === "pi.virtual-model-state") as any)?.data.state;
    try {
      await session.bindExtensions({ onError: event => errors.push(event.error) });
      await session.setModel(runtime.getModel("tripp", modelId)!);
      await notify();
      expect(advisors).toBe(0);
      expect(state()).toBeUndefined();
      phase = "work";
      await session.prompt("Perform eight bounded test responses, then stop.");
      expect(workTurns).toBe(TURN_BUDGET);
      expect(advisors).toBe(count);
      const before = structuredClone(state());
      phase = "notification";
      await notify();
      await notify();
      expect(advisors).toBe(count);
      expect(state()).toEqual(before);
      expect(state().turns).toBe(TURN_BUDGET);
      const notifications = manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "swarm-message");
      expect(notifications).toHaveLength(3);
      expect(notifications.every(entry => (entry as any).display === true)).toBe(true);
      expect(JSON.stringify(notifications)).not.toContain("Advisor openai/");
      phase = "new-work";
      await session.prompt("Start another bounded task.");
      expect(advisors).toBe(count * 2);
      expect(state()).toMatchObject({ round: 2, turns: 1 });
      expect(executors).toBe(TURN_BUDGET + 4);
      expect(errors).toEqual([]);
      expect(session.messages.filter(message => message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "aborted"))).toEqual([]);
    } finally { session.dispose(); await rm(dir, { recursive: true, force: true }); }
  },
);
