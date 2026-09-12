import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../../", import.meta.url));
const addons = process.env.PI_CODE_ADDON_DIR
  ? ["pi-codex-web-run", "pi-codex-imagegen"].map((name) => join(process.env.PI_CODE_ADDON_DIR!, "node_modules/@howaboua", name))
  : [];

test("Pi discovers the explicit package whitelist with unique tool registrations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-code-discovery-"));
  const originalScript = process.argv[1];
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "pi-codex-conversion.json"), JSON.stringify({
    executionMode: "normal", voiceFeaturesOnly: true,
    tools: { applyPatchOnly: false, viewImageOnly: false, autoReasoning: false },
    compaction: { contextManagement: "off", hybridCompaction: false, responsesCompaction: false },
  }));
  process.argv[1] = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [root, ...addons] }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(23 + addons.length);
    expect(result.extensions.filter((extension) => extension.commands.has("fast"))).toHaveLength(1);
    const names = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("bash");
    expect(names).toContain("bg_process");
    expect(names).toContain("sleep");
    expect(names).toContain("ask_user");
    expect(names).toContain("subagent");
    expect(names).toContain("swarm_spawn");
    expect(names).toContain("swarm_integrate");
    expect(names).toContain("complain");
    expect(result.extensions.filter((extension) => extension.commands.has("swarm:start"))).toHaveLength(1);
    expect(names).toContain("mixture_run");
    expect(names).toContain("run_experiment");
    expect(result.extensions.filter((extension) => extension.commands.has("mixture"))).toHaveLength(1);
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(23 + addons.length);
  } finally {
    process.argv[1] = originalScript;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
