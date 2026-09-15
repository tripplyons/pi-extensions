export const fixtureToken = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.test`;

export function toolResponse(name: string, args: Record<string, unknown>, namespace?: string, chat = false) {
	if (chat) {
		const call = { index: 0, id: `call_${crypto.randomUUID()}`, type: "function", function: { name: namespace ?? name, arguments: JSON.stringify(namespace ? { action: name, ...args } : args) } };
		return [
			{ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } },
		].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
	}
	const item = { type: "function_call", id: "fc_fixture", call_id: `call_${crypto.randomUUID()}`, name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args) };
	return [
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 7, output_tokens: 4 } } },
	].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}

export function summaryResponse(text = "Role checkpoint summary: preserve the task and private notes.") {
	const part = { type: "output_text", text, annotations: [] };
	const item = { type: "message", id: "msg_summary", role: "assistant", content: [part] };
	return [
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { ...part, text: "" } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: part.text },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 7, output_tokens: 4 } } },
	].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}
