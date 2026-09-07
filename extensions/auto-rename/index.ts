import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_CONVERSATION_CHARS = 60_000;
const SYSTEM_PROMPT = `Name coding-agent sessions.
Return only a short, specific name of 3 to 8 words. Do not use quotes or punctuation-only decoration.`;

function conversationText(ctx: ExtensionContext): string {
	const turns: string[] = [];

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;

		const content = entry.message.content;
		const text = (typeof content === "string"
			? content
			: content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")
		).trim();
		if (text) turns.push(`${entry.message.role === "user" ? "User" : "Assistant"}: ${text}`);
	}

	return turns.join("\n\n").slice(0, MAX_CONVERSATION_CHARS);
}

async function generateName(ctx: ExtensionContext): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("No model selected");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);

	const response = await completeSimple(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: `Name this session from the conversation below. Do not answer the task.\n\n${conversationText(ctx)}`,
				}],
				timestamp: Date.now(),
			}],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: 64,
		},
	);

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
