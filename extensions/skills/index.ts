import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function skillRoots(cwd: string, home = homedir(), config = process.env.XDG_CONFIG_HOME) {
  const configRoot = config && isAbsolute(config) ? config : join(home, ".config");
  return [
    join(cwd, ".stack-agent/skills"),
    join(cwd, ".agents/skills"),
    join(configRoot, "stack-agent/skills"),
    join(home, ".agents/skills"),
  ].filter(path => existsSync(path));
}

export default function skills(pi: ExtensionAPI) {
  pi.on("resources_discover", event => ({ skillPaths: skillRoots(event.cwd) }));
  pi.on("before_agent_start", event => ({
    systemPrompt: event.systemPrompt + "\nWhen a task matches a skill, use read to load its SKILL.md before following it. Resolve relative paths against the skill file's directory. Skill descriptions specify activation conditions; do not activate a skill merely because it is available.",
  }));
}
