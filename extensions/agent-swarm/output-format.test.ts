import { expect, test } from "bun:test";
import { formatWorkerOutput, sanitizeTerminalText } from "./output-format.ts";

test("formats transcript and tool events without protocol noise or tool results", () => {
	const input = [
		{ type: "session", id: "secret" },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "duplicate" } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
		{ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } },
		{ type: "tool_execution_end", toolName: "read", result: "very large secret result" },
	].map(JSON.stringify).join("\n");
	expect(formatWorkerOutput(input)).toBe("Assistant: Done\n→ read\n✓ read");
	expect(formatWorkerOutput(input)).not.toContain("secret");
});

test("preserves diagnostics and strips terminal control sequences everywhere", () => {
	const input = `\x1b]52;clipboard\x07warning\n${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "\x1b[31mred\x1b[0m" } })}`;
	expect(formatWorkerOutput(input)).toBe("warning\nAssistant: red");
	expect(sanitizeTerminalText("ok\x1bPpayload\x1b\\safe\x00")).toBe("oksafe ");
});

test("marks failed tools without exposing arguments or results", () => {
	const input = [
		{ type: "tool_execution_start", toolName: "exec", args: { command: "x".repeat(300) } },
		{ type: "tool_execution_end", toolName: "exec", isError: true, result: "ignored" },
	].map(JSON.stringify).join("\n");
	const formatted = formatWorkerOutput(input);
	expect(formatted).toBe("→ exec\n✗ exec");
	expect(formatted).not.toContain("xxx");
	expect(formatted).not.toContain("ignored");
});

test("hides thinking, deltas, malformed JSON payloads, bidi formatting, and bounds lines", () => {
	const secret = "private-thought";
	const input = [
		JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: secret } }),
		JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } }),
		'{"secret":"torn"',
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `D\u202eo\u200bne ${"x".repeat(600)}` }] } }),
	].join("\n");
	const formatted = formatWorkerOutput(input);
	expect(formatted).not.toContain(secret);
	expect(formatted).not.toContain("torn");
	expect(formatted).toContain("[unrecognized worker output]");
	expect(formatted.match(/Done/g)).toHaveLength(1);
	expect(formatted).not.toMatch(/[\u200b\u202e]/);
	expect(Math.max(...formatted.split("\n").map((line) => line.length))).toBeLessThanOrEqual(511);
});
