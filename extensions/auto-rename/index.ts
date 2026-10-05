import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { priorityPayload } from "../fast-mode/index.ts";

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
	const model = ["openai", "openai-codex"]
		.map(provider => ctx.modelRegistry.find(provider, "gpt-6-luna"))
		.find(model => model && ctx.modelRegistry.hasConfiguredAuth(model));
	if (!model) throw new Error("Title generation requires gpt-6-luna with OpenAI authentication. Use /login and check /model.");

	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) throw new Error(`No provider registered for "${model.provider}"`);

	const stream = ctx.modelRegistry.streamSimple(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [{
				role: "user",
				content: [{ type: "text", text: `Name this session from the conversation below. Do not answer the task.\n\n${conversationText(ctx)}` }],
				timestamp: Date.now(),
			}],
		},
		// Keep this nested request out of the provider's live agent session.
		{
			maxTokens: 64,
			reasoning: "low",
			cacheRetention: "none",
			onPayload: (payload, physical) => priorityPayload(payload, physical.provider, true),
		},
	);

	let response: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "done") response = event.message;
		if (event.type === "error") response = event.error;
	}
	if (!response) throw new Error("Naming request ended without a terminal result");

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
