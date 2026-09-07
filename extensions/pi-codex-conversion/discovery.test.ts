import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../../", import.meta.url));
const addons = process.env.PI_CODE_ADDON_DIR
  ? ["pi-codex-web-run", "pi-codex-imagegen", "pi-ask"].map((name) => join(process.env.PI_CODE_ADDON_DIR!, "node_modules/@howaboua", name))
  : [];

test("Pi discovers the explicit package whitelist with unique tool registrations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-code-discovery-"));
  const originalScript = process.argv[1];
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
    expect(result.extensions).toHaveLength(13 + addons.length);
    const names = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("exec");
    expect(names).toContain("wait");
    expect(names).toContain("new_context");
    expect(names).toContain("subagent");
    expect(names).toContain("run_experiment");
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(13 + addons.length);
  } finally {
    process.argv[1] = originalScript;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
