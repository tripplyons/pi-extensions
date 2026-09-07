import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENTS_FILE = "AGENTS.md";
const INSTRUCTION = `## Local AGENTS.md

Before working on each user request, read ./AGENTS.md first if you have not already read it. Do this before any other tool call or code inspection, and follow the instructions it contains. Do not reread it.`;

function hasLocalAgentsFile(cwd: string): boolean {
	const path = join(cwd, AGENTS_FILE);
	return existsSync(path) && statSync(path).isFile();
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!hasLocalAgentsFile(ctx.cwd)) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${INSTRUCTION}`,
		};
	});
}
