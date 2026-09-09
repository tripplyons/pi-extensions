const ESCAPE_SEQUENCE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*(?:\x1b\\)|\[[0-?]*[ -\/]*[@-~]|[@-_])/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Remove terminal commands while retaining ordinary newlines and tabs. */
export const sanitizeTerminalText = (value: string) => value.replace(ESCAPE_SEQUENCE, "").replace(CONTROL, " ");

const messageText = (message: any): string => {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
};

const compact = (value: unknown, limit = 140) => {
	let rendered: string;
	try { rendered = typeof value === "string" ? value : JSON.stringify(value); }
	catch { rendered = "[unprintable]"; }
	rendered = sanitizeTerminalText(rendered ?? "").replace(/\s+/g, " ").trim();
	return rendered.length > limit ? `${rendered.slice(0, limit - 1)}…` : rendered;
};

/** Convert Pi's newline-delimited JSON protocol into a small, safe transcript. */
export function formatWorkerOutput(captured: string): string {
	const output: string[] = [];
	for (const rawLine of captured.split("\n")) {
		if (!rawLine.trim()) continue;
		let event: any;
		try { event = JSON.parse(rawLine); }
		catch { output.push(sanitizeTerminalText(rawLine)); continue; }
		if (!event || typeof event !== "object") continue;
		switch (event.type) {
			case "message_end": {
				const role = event.message?.role;
				const body = sanitizeTerminalText(messageText(event.message)).trim();
				if (body && (role === "assistant" || role === "user")) output.push(`${role === "assistant" ? "Assistant" : "User"}: ${body}`);
				if ((event.message?.stopReason === "error" || event.message?.stopReason === "aborted") && event.message?.errorMessage) output.push(`Error: ${sanitizeTerminalText(String(event.message.errorMessage))}`);
				break;
			}
			case "tool_execution_start": {
				const name = sanitizeTerminalText(typeof event.toolName === "string" ? event.toolName : "tool");
				const args = event.args === undefined ? "" : compact(event.args);
				output.push(`→ ${name}${args ? ` ${args}` : ""}`);
				break;
			}
			case "tool_execution_end": {
				const name = sanitizeTerminalText(typeof event.toolName === "string" ? event.toolName : "tool");
				output.push(`${event.isError ? "✗" : "✓"} ${name}`);
				break;
			}
		}
	}
	return output.join("\n");
}
