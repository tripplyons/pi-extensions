import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import minimax from "./index.ts";
import { Tasks } from "./tasks.ts";
import { harness } from "../../lib/harness.ts";
import { installThresholdCompaction } from "./compaction.ts";

function setup() {
  const h = harness();
  h.entries.push({ type: "custom", customType: "rework:minimax", data: { enabled: true } });
  h.ctx.getContextUsage = () => ({ tokens: 100_000 });
  h.ctx.isIdle = () => true;
  h.ctx.abort = () => {};
  h.pi.sendMessage = (message: any) => h.sent.push(message.content);
  installThresholdCompaction(h.pi);
  return h;
}

test("threshold interruption resumes once; completed runs do not auto-continue", async () => {
  const h = setup(); let aborted = 0; let compactions = 0;
  h.ctx.abort = () => { aborted++; };
  h.ctx.compact = ({ onComplete }: any) => { compactions++; onComplete(); };
  await h.emit("context"); await h.emit("context"); expect(aborted).toBe(1);
  await h.emit("agent_settled"); expect(h.sent).toHaveLength(1);
  await h.emit("agent_settled"); expect(compactions).toBe(2); expect(h.sent).toHaveLength(1);
});

test("failed compaction does not retry forever and stale callbacks cannot resume another branch", async () => {
  const h = setup(); let options: any; let count = 0;
  h.ctx.compact = (value: any) => { options = value; count++; };
  await h.emit("context"); await h.emit("agent_settled");
  options.onError(new Error("offline"));
  await h.emit("context"); await h.emit("agent_settled"); expect(count).toBe(1);
  await h.emit("input"); await h.emit("context"); await h.emit("agent_settled");
  expect(count).toBe(2);
  await h.emit("session_tree"); options.onComplete(); expect(h.sent).toEqual([]);
});

test.each([false, true])("Pi SDK uses a checkpoint only when archiving cannot suffice (archive-only: %s)", async (archiveOnly) => {
  const root = await mkdtemp(join(tmpdir(), "minimax-sdk-"));
  const tasks = new Tasks(join(root, "tasks"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
    const model = runtime.getModels("anthropic")[0];
    expect(model).toBeDefined();
    await runtime.setRuntimeApiKey(model.provider, "test-key-never-sent");
    const settings = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 100 }, retry: { enabled: false } });
    const manager = SessionManager.inMemory(root);
    manager.appendCustomEntry("rework:minimax", { enabled: true });
    manager.appendCustomEntry("rework:codex-compaction", { threshold: archiveOnly ? 100000 : 1000 });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }), extensionFactories: [pi => {
      // Simulate a verbose integration result before MiniMax's admission hook.
      if (archiveOnly) pi.on("tool_result", event => event.toolName === "bash" ? { content: [{ type: "text", text: "verbose output\n".repeat(60000) }] } : undefined);
      minimax(pi, tasks);
    }] });
    await loader.reload();
    let requests = 0; let summaries = 0;
    const assistant = (content: AssistantMessage["content"], tokens: number, stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now(), usage: { input: tokens, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    runtime.streamSimple = (_model, context, options) => {
      const stream = createAssistantMessageEventStream();
      if (options?.signal?.aborted) {
        stream.push({ type: "error", reason: "aborted", error: assistant([], 0, "aborted") }); return stream;
      }
      requests++;
      if (archiveOnly && requests === 2) {
        const result = context.messages.find(message => message.role === "toolResult");
        expect(JSON.stringify(result)).toContain("minimax archive");
        expect(JSON.stringify(context.messages).length).toBeLessThan(20000);
      }
      if (requests > 2) throw new Error("Unexpected continuation loop");
      const message = requests === 1
        ? assistant([{ type: "toolCall", id: "once", name: "bash", arguments: { command: "echo executed >> executions; printf %06000d 0" } }], archiveOnly ? 120000 : 2000, "toolUse")
        : assistant([{ type: "text", text: "Finished after checkpoint" }], 100, "stop");
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      return stream;
    };
    runtime.complete = async (_model, context) => {
      summaries++;
      expect(context.systemPrompt).toContain("loss-aware checkpoint");
      return assistant([{ type: "text", text: "## Goal\nFinish the request.\n## Constraints & Preferences\n(none)\n## Completed Work\nExecuted Bash once.\n## Current State\nTool returned.\n## Blockers\n(none)\n## Key Decisions\nDo not repeat Bash.\n## Pending User Asks\nReport result.\n## Critical Context & Relevant Files\nexecutions" }], 100, "stop");
    };
    const created = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: manager });
    session = created.session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: error => errors.push(error) });
    await session.prompt("Run the command once, then report the result.");
    // ctx.compact uses callbacks; its resumed run outlives the initial prompt.
    for (let i = 0; i < 200 && !session.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Finished after checkpoint")); i++) await new Promise(resolve => setTimeout(resolve, 10));
    await session.waitForIdle();
    expect(errors).toEqual([]);
    expect(summaries).toBe(archiveOnly ? 0 : 1); expect(requests).toBe(2);
    expect(manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(archiveOnly ? 0 : 1);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(root, "executions"), "utf8")).toBe("executed\n");
    expect(session.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Finished after checkpoint"))).toBe(true);
  } finally {
    await session?.abort(); session?.dispose(); await tasks.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
