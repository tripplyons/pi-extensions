import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("native runtime preserves file tools and executes bg-bash in an isolated Pi session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-code-runtime-"));
  const agentDir = join(dir, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousMixtureHome = process.env.PI_MIXTURE_HOME;
  const previousCache = process.env.XDG_CACHE_HOME;
  const previousSocket = process.env.PI_BG_BASH_TMUX_SOCKET;
  let session;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_MIXTURE_HOME = join(dir, "mixture");
    process.env.XDG_CACHE_HOME = join(dir, "cache");
    process.env.PI_BG_BASH_TMUX_SOCKET = join(dir, "bg.sock");
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
    ({ session } = await createAgentSession({
      cwd: dir, agentDir, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(dir),
      modelRuntime,
      model: modelRuntime.getModels("openai-codex")[0],
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
    expect(errors).toEqual([]);
    const names = session.getActiveToolNames();
    for (const name of ["read", "write", "edit", "bash", "bg_process", "sleep", "ask_user", "subagent_process"]) expect(names).toContain(name);
    for (const name of ["exec", "wait", "new_context", "history", "apply_patch", "exec_command", "read_file", "ask"]) expect(names).not.toContain(name);
    const call = (name: string, args: any) => session.agent.state.tools.find((tool) => tool.name === name)!.execute(name, args, new AbortController().signal);
    await call("write", { path: "smoke.txt", content: "before\n" });
    await call("edit", { path: "smoke.txt", edits: [{ oldText: "before", newText: "after" }] });
    expect(await readFile(join(dir, "smoke.txt"), "utf8")).toBe("after\n");
    expect(JSON.stringify((await call("read", { path: "smoke.txt" })).content)).toContain("after");
    expect(JSON.stringify((await call("bash", { command: "printf native-shell-ok" })).content)).toContain("native-shell-ok");
    expect(JSON.stringify((await call("subagent_process", { action: "list" })).content)).toContain("No subagent jobs");
    const mixture = resourceLoader.getExtensions().extensions.find(extension => extension.commands.has("mixture"))!.commands.get("mixture")!;
    const commandContext = session.extensionRunner.createCommandContext();
    expect(session.getActiveToolNames()).not.toContain("mixture_run");
    await mixture.handler("", commandContext);
    expect(session.getActiveToolNames()).toContain("mixture_run");
    expect(session.getActiveToolNames()).toContain("mixture_process");
    await mixture.handler("", commandContext);
    expect(session.getActiveToolNames()).not.toContain("mixture_run");
    expect(session.getActiveToolNames()).not.toContain("mixture_process");
    expect(session.getActiveToolNames()).toContain("run_experiment");
    expect(JSON.stringify((await call("run_experiment", { command: "printf native-experiment-ok" })).content)).toContain("native-experiment-ok");
    if (addons.length) for (const name of ["web_run", "imagegen"]) expect(session.getActiveToolNames()).toContain(name);

  } finally {
    if (previousMixtureHome === undefined) delete process.env.PI_MIXTURE_HOME;
    else process.env.PI_MIXTURE_HOME = previousMixtureHome;
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    spawnSync("tmux", ["-S", "bg.sock", "kill-server"], { cwd: dir });
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
    if (previousSocket === undefined) delete process.env.PI_BG_BASH_TMUX_SOCKET; else process.env.PI_BG_BASH_TMUX_SOCKET = previousSocket;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
