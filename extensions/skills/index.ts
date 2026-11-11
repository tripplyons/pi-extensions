import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const skillPolicy = "When a task matches a skill, use read to load its SKILL.md before following it. Resolve relative paths against the skill file's directory. Skill descriptions specify activation conditions; do not activate a skill merely because it is available.";

export default function skills(pi: ExtensionAPI) {
  // appendSystemPrompt reaches Pi-native providers and the Claude Agent SDK bridge,
  // which drops custom prompt sections.
  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    const current = options.appendSystemPrompt;
    if (current?.includes(skillPolicy)) return;
    options.appendSystemPrompt = current ? `${current}\n\n${skillPolicy}` : skillPolicy;
  });
}
