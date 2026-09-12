import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCodeModeExtensionToolSnapshot } from "@howaboua/pi-codex-conversion/dist/code-mode-extension-tools.js";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("published Code runtime executes shell and patch in an isolated Pi session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-code-runtime-"));
  const agentDir = join(dir, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousMixtureHome = process.env.PI_MIXTURE_HOME;
  let session;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_MIXTURE_HOME = join(dir, "mixture");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "pi-codex-conversion.json"), JSON.stringify({
      executionMode: "code",
      voiceFeaturesOnly: false,
      compaction: { contextManagement: "remote", hybridCompaction: true, responsesCompaction: true },
    }));
    const addons = process.env.PI_CODE_ADDON_DIR
      ? ["pi-codex-web-run", "pi-codex-imagegen", "pi-ask"].map((name) => join(process.env.PI_CODE_ADDON_DIR!, "node_modules/@howaboua", name))
      : [];
    await mkdir(join(dir, ".auto"));
    await writeFile(join(dir, ".auto/log.jsonl"), JSON.stringify({ type: "config", name: "Code smoke", metricName: "runtime_ms", metricUnit: "ms", bestDirection: "lower" }) + "\n");
    const settingsManager = SettingsManager.inMemory({ packages: addons });
    let inspectionPi;
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir, agentDir, settingsManager,
      extensionFactories: [(pi) => { inspectionPi = pi; }],
      additionalExtensionPaths: ["./index.ts", "../subagent/index.ts", "../tripp-autoresearch/index.ts", "../mixture/index.ts"].map((path) => fileURLToPath(new URL(path, import.meta.url))),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models-cache"), allowModelNetwork: false,
    });
    ({ session } = await createAgentSession({
      cwd: dir, agentDir, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(dir),
      modelRuntime,
      model: modelRuntime.getModels("openai-codex")[0],
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
    expect(errors).toEqual([]);
    expect(session.getActiveToolNames()).toContain("exec");
    expect(session.getActiveToolNames()).not.toContain("bash");
    expect(session.getActiveToolNames()).toContain("new_context");
    const history = session.agent.state.tools.find((tool) => tool.name === "history")!;
    expect(history).toBeDefined();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("test: network disabled"); };
    try {
      await expect(history.execute("remote-without-auth", { action: "list_windows" }, new AbortController().signal)).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
    const exec = session.agent.state.tools.find((tool) => tool.name === "exec")!;
    const result = await exec.execute("smoke", { code: `
      text(await tools.exec_command({ cmd: "printf code-shell-ok", login: false }));
      text(await tools.apply_patch("*** Begin Patch\\n*** Add File: smoke.txt\\n+code-patch-ok\\n*** End Patch"));
    ` }, new AbortController().signal);
    expect(result.details).not.toHaveProperty("scriptError");
    expect(JSON.stringify(result.content)).toContain("code-shell-ok");
    expect(await readFile(join(dir, "smoke.txt"), "utf8")).toBe("code-patch-ok\n");
    const nested = await exec.execute("local-tool", { code: 'text(await tools.subagent_process({ action: "list" })); text(Object.keys(tools));' }, new AbortController().signal);
    expect(nested.details).not.toHaveProperty("scriptError");
    expect(JSON.stringify(nested.content)).toContain("No subagent jobs");
    expect(JSON.stringify(nested.content)).not.toContain("mixture_run");
    expect(JSON.stringify(nested.content)).not.toContain("mixture_process");
    const mixture = resourceLoader.getExtensions().extensions.find(extension => extension.commands.has("mixture"))!.commands.get("mixture")!;
    const commandContext = session.extensionRunner.createCommandContext();
    await mixture.handler("", commandContext);
    const enabled = await exec.execute("mixture-enabled", { code: 'text(Object.keys(tools)); text(await tools.mixture_process({ action: "list" }));' }, new AbortController().signal);
    expect(enabled.details).not.toHaveProperty("scriptError");
    expect(JSON.stringify(enabled.content)).toContain("mixture_run");
    expect(JSON.stringify(enabled.content)).toContain("mixture_process");
    await mixture.handler("", commandContext);
    const disabled = await exec.execute("mixture-disabled", { code: 'text(Object.keys(tools));' }, new AbortController().signal);
    expect(disabled.details).not.toHaveProperty("scriptError");
    expect(JSON.stringify(disabled.content)).not.toContain("mixture_run");
    expect(JSON.stringify(disabled.content)).not.toContain("mixture_process");
    expect(session.getActiveToolNames()).not.toContain("run_experiment");
    const experiment = await exec.execute("experiment", { code: 'text(await tools.run_experiment({ command: "printf experiment-code-ok" }));' }, new AbortController().signal);
    expect(experiment.details).not.toHaveProperty("scriptError");
    expect(JSON.stringify(experiment.content)).toContain("experiment-code-ok");
    if (addons.length) {
      const definitions = getCodeModeExtensionToolSnapshot(inspectionPi, undefined).tools;
      const ask = definitions.find((tool) => tool.name === "ask")!;
      expect(ask.isBlocking?.({ prompts: [{ title: "Choose" }] })).toBe(true);
      expect(ask.isBlocking?.({ prompts: [{ title: "Choose" }], delivery: "steer" })).toBe(false);
      for (const name of ["web__run", "image_gen__imagegen", "ask"]) {
        expect(JSON.stringify(nested.content)).toContain(name);
      }
    }
  } finally {
    if (previousMixtureHome === undefined) delete process.env.PI_MIXTURE_HOME;
    else process.env.PI_MIXTURE_HOME = previousMixtureHome;
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
