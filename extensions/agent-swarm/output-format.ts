const ESCAPE_SEQUENCE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*(?:\x1b\\)|\[[0-?]*[ -\/]*[@-~]|[@-_])/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const INVISIBLE_FORMATTING = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const MAX_LINE = 500;

/** Remove terminal commands while retaining ordinary newlines and tabs. */
export const sanitizeTerminalText = (value: string) => value.replace(ESCAPE_SEQUENCE, "").replace(CONTROL, " ").replace(INVISIBLE_FORMATTING, "");

const boundedLines = (value: string) => sanitizeTerminalText(value).split(/\r?\n/).map((line) => line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line);

const messageText = (message: any): string => {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("");
};

/** Convert Pi's newline-delimited JSON protocol into a small, safe transcript. */
export function formatWorkerOutput(captured: string): string {
	const output: string[] = [];
	for (const rawLine of captured.split("\n")) {
		if (!rawLine.trim()) continue;
		let event: any;
		try { event = JSON.parse(rawLine); }
		catch {
			// A JSON-looking fragment may be a torn tmux capture. Never echo it.
			if (/^\s*[\[{]/.test(rawLine)) output.push("[unrecognized worker output]");
			else output.push(...boundedLines(rawLine));
			continue;
		}
		if (!event || typeof event !== "object") continue;
		switch (event.type) {
			case "message_end": {
				const role = event.message?.role;
				const body = messageText(event.message).trim();
				if (body && (role === "assistant" || role === "user")) {
					const lines = boundedLines(body);
					output.push(`${role === "assistant" ? "Assistant" : "User"}: ${lines[0]}`, ...lines.slice(1));
				}
				if ((event.message?.stopReason === "error" || event.message?.stopReason === "aborted") && event.message?.errorMessage) {
					const lines = boundedLines(String(event.message.errorMessage));
					output.push(`Error: ${lines[0]}`, ...lines.slice(1));
				}
				break;
			}
			case "tool_execution_start": {
				const name = boundedLines(typeof event.toolName === "string" ? event.toolName : "tool")[0];
				output.push(`→ ${name}`);
				break;
			}
			case "tool_execution_end": {
				const name = boundedLines(typeof event.toolName === "string" ? event.toolName : "tool")[0];
				output.push(`${event.isError ? "✗" : "✓"} ${name}`);
				break;
			}
		}
	}
	return output.join("\n");
}
