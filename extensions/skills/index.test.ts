import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { harness } from "../../lib/harness.ts";
import install, { skillRoots } from "./index.ts";

test("Stack skill roots feed Pi's loader, prompt and explicit-only policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-skills-"));
  try {
    const cwd = join(root, "project"), home = join(root, "home"), config = join(root, "config");
    const roots = [join(cwd, ".stack-agent/skills"), join(cwd, ".agents/skills"), join(config, "stack-agent/skills"), join(home, ".agents/skills")];
    for (const [i, path] of roots.entries()) {
      mkdirSync(join(path, `sample-${i}`), { recursive: true });
      writeFileSync(join(path, `sample-${i}/SKILL.md`), `---\nname: sample-${i}\ndescription: Example ${i}\n${i === 3 ? "disable-model-invocation: true\n" : ""}---\nUse local references.\n`);
    }
    expect(skillRoots(cwd, home, config)).toEqual(roots);
    const loaded = loadSkills({ cwd, agentDir: join(root, "agent"), skillPaths: roots, includeDefaults: false });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.skills.map(s => s.name)).toEqual(["sample-0", "sample-1", "sample-2", "sample-3"]);
    const prompt = formatSkillsForPrompt(loaded.skills);
    expect(prompt).toContain("sample-2"); expect(prompt).not.toContain("sample-3");
    const h = harness(); install(h.pi);
    const [policy] = await h.emit("before_agent_start", { systemPrompt: "Base" });
    expect(policy.systemPrompt).toStartWith("Base\n");
    expect(policy.systemPrompt).toContain("use read to load its SKILL.md");
    expect(skillRoots(cwd, home, "relative")).not.toContain(roots[2]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
