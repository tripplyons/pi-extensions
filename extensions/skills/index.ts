import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function skills(pi: ExtensionAPI) {
  pi.on("before_agent_start", event => ({
    systemPrompt: event.systemPrompt + "\nWhen a task matches a skill, use read to load its SKILL.md before following it. Resolve relative paths against the skill file's directory. Skill descriptions specify activation conditions; do not activate a skill merely because it is available.",
  }));
}
