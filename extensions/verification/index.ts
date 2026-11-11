import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Finishing rules for every run. appendSystemPrompt reaches Pi-native providers
 * and the Claude Agent SDK bridge, which drops custom sections and guidelines.
 */
export const verificationRules = `# Finishing work
Before you report a task as done, reread the request and list each requirement, including output paths, formats, and edge cases it names.
Run the checks a reviewer would run: the project's tests, the exact command the request gives, or a direct inspection of the output.
If a check fails, fix the cause and run the check again. Keep working until every requirement passes or a real blocker remains.
Do not report done while a requirement is unchecked. Name each check you skipped and why.`;

export default function verification(pi: ExtensionAPI) {
  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    const current = options.appendSystemPrompt;
    if (current?.includes(verificationRules)) return;
    options.appendSystemPrompt = current ? `${current}\n\n${verificationRules}` : verificationRules;
  });
}
