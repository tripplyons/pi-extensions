import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeLuna, lunaModel } from "../../lib/luna.ts";

const MAX_MESSAGE_CHARS = 60_000;
const SYSTEM_PROMPT = `Name coding-agent sessions.
Return only a short, specific name of 3 to 8 words. Do not use quotes or punctuation-only decoration.`;

function firstUserMessageText(ctx: ExtensionContext): string {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;

		const content = entry.message.content;
		return (typeof content === "string"
			? content
			: content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")
		).trim().slice(0, MAX_MESSAGE_CHARS);
	}

	return "";
}

async function generateName(ctx: ExtensionContext): Promise<string> {
	if (!lunaModel(ctx)) throw new Error("Title generation requires gpt-6-luna with OpenAI authentication. Use /login and check /model.");
	const response = await completeLuna(ctx, {
		systemPrompt: SYSTEM_PROMPT,
		messages: [{
			role: "user",
			content: [{ type: "text", text: `Name this session from the first user message below. Do not answer the task.\n\n${firstUserMessageText(ctx)}` }],
			timestamp: Date.now(),
		}],
	}, { maxTokens: 64 });

	if (response.stopReason === "error") throw new Error(response.errorMessage || "Naming request failed");
	if (response.stopReason === "aborted") throw new Error("Naming request was aborted");

	const text = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
	const name = text.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").slice(0, 80).trim();
	if (!name) throw new Error("Naming request returned an empty name");
	return name;
}

export default function (pi: ExtensionAPI) {
	let naming = false;

	pi.on("agent_end", async (_event, ctx) => {
		if (naming || pi.getSessionName()) return;

		naming = true;
		ctx.ui.setStatus("auto-rename", "naming…");
		try {
			pi.setSessionName(await generateName(ctx));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Auto-rename failed: ${message}`, "warning");
		} finally {
			ctx.ui.setStatus("auto-rename", undefined);
			naming = false;
		}
	});
}
