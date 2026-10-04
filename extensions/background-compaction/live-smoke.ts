// Opt-in live requests. No file/shell tools and no saved session.
import assert from "node:assert/strict";
import { lazyStream, type AssistantMessageEvent, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import council from "../council/index.ts";
import presentation from "../presentation/index.ts";
import subscription from "../openai-subscription/index.ts";
import background, { tuning } from "./index.ts";

const prepareAt = tuning.prepareAt;
tuning.prepareAt = 0;
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const manager = SessionManager.inMemory(process.cwd());
for (let i = 0; i < 10; i++) {
  manager.appendMessage({ role: "user", content: `Synthetic smoke-test context ${i}. No actions are required for this old message. `.repeat(50), timestamp: Date.now() });
}
const records: { role: string; model: string; effort: unknown; stop?: string }[] = [];
const statuses = new Map<string, string>(), errors: string[] = [];
let footer: any;
let markReady!: () => void;
const ready = new Promise<void>(resolve => { markReady = resolve; });
const loader = new DefaultResourceLoader({
  cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  extensionFactories: [council, presentation, background, subscription, pi => {
    pi.on("session_start", (_event, ctx) => {
      pi.setActiveTools([]);
      for (const id of ["openai", "openai-codex", "anthropic"]) {
        const provider = ctx.modelRegistry.getProvider(id);
        if (!provider) continue;
        const audited: Provider = {
          ...provider,
          streamSimple(model, context, options) {
            const prompt = String(context.messages[0]?.content);
            const record = { role: prompt.includes("independent advisor") ? "advisor"
              : prompt.includes("context summarization assistant") ? "summary" : "executor",
              model: model.id, effort: options?.reasoning, stop: undefined as string | undefined };
            records.push(record);
            console.log(JSON.stringify({ event: "request", ...record }));
            return lazyStream(model, async () => (async function* (): AsyncIterable<AssistantMessageEvent> {
              for await (const event of provider.streamSimple(model, context, options)) {
                if (event.type === "done" || event.type === "error") {
                  record.stop = (event.type === "done" ? event.message : event.error).stopReason;
                  console.log(JSON.stringify({ event: "result", ...record }));
                }
                yield event;
              }
            })());
          },
        };
        pi.registerProvider(audited);
      }
    });
  }],
});
await loader.reload();
const { session } = await createAgentSession({
  cwd: process.cwd(), modelRuntime: runtime, resourceLoader: loader, sessionManager: manager, noTools: "all",
  settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, cacheWarming: false,
    compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 1_000 } }),
});
const run = async () => {
  await session.bindExtensions({ mode: "print", onError: event => errors.push(event.error), uiContext: {
    setStatus(key: string, value?: string) {
      if (value) statuses.set(key, value); else statuses.delete(key);
      if (key !== "background-compaction") return;
      console.log(JSON.stringify({ event: "background", state: value }));
      if (value === "background: ready") markReady();
    },
    notify(text: string, type: string) { if (type === "warning" || type === "error") errors.push(text); },
    setToolsExpanded() {}, setTitle() {}, setWorkingIndicator() {}, setWorkingVisible() {},
    setFooter(factory: any) {
      footer = factory?.({}, { fg: (_color: string, text: string) => text }, { getExtensionStatuses: () => statuses });
    },
  } as any });
  await session.setModel(runtime.getModel("tripp", "council")!);
  assert(footer.render(60)[0].includes("background: waiting"));
  assert(!footer.render(60)[0].includes("medium"));
  await session.prompt("This is a harmless compaction smoke test. Reply with the single word READY. Do not execute any actions.");
  await ready;
  assert(footer.render(60)[0].includes("background: ready"));
  const state = () => (manager.getBranch().findLast(entry => entry.type === "custom" &&
    entry.customType === "pi.virtual-model-state") as any).data.state;
  const before = structuredClone(state());
  const requestsBefore = records.length;
  const result = await session.compact();
  assert(result.summary.trim());
  assert.equal(records.length, requestsBefore, "Cached compaction must not make another request");
  assert.deepEqual(state(), before);
  assert(footer.render(60)[0].includes("background: waiting"));
  tuning.prepareAt = prepareAt;
  await session.prompt("This is the post-compaction smoke check. Reply with the single word DONE. Do not execute any actions.");
  assert.equal(state().round, 2);
  assert.deepEqual(errors, []);
  assert.equal(records.filter(record => record.role === "advisor").length, 6);
  assert.equal(records.filter(record => record.role === "executor").length, 2);
  const summaries = records.filter(record => record.role === "summary");
  assert(summaries.length >= 1);
  assert(summaries.every(record => record.model === "gpt-6.1-sol" && record.effort === "medium"));
  assert(records.every(record => record.stop === "stop"));
  console.log(JSON.stringify({ event: "verified", cachedCompaction: true, preservedCouncilState: true,
    footer: footer.render(60)[0], summaries: summaries.length, requests: records.length }));
};
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([run(), new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { void session.abort(); reject(new Error("Live compaction test exceeded four minutes")); }, 240_000);
  })]);
} finally { clearTimeout(timer); tuning.prepareAt = prepareAt; session.dispose(); }
