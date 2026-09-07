import { describe, expect, test } from "bun:test";
import { loadConfig, parseConfig } from "./config.ts";
import { COOLDOWN_MS, createTask, evidencePacket, nextAction, parseVerdict, reserveEscalation, TOOL_ARGUMENT_CHARS, TOOL_RESULT_CHARS } from "./policy.ts";

const pass = { model: "a", verdict: parseVerdict('{"verdict":"pass","findings":[],"checks":[]}') };
const revise = { model: "b", verdict: parseVerdict('{"verdict":"revise","findings":["missing edge case"],"checks":["test empty input"]}') };

describe("fusion policy", () => {
	test("reserves immediately, limits concurrent calls, resets per prompt, and permits five-minute reuse", () => {
		const task = createTask("fix");
		expect(reserveEscalation(task, 100)).toBe(0);
		expect(reserveEscalation(task, 100)).toBe(COOLDOWN_MS);
		expect(reserveEscalation(task, 100 + COOLDOWN_MS - 1)).toBe(1);
		expect(reserveEscalation(task, 100 + COOLDOWN_MS)).toBe(0);
		expect(reserveEscalation(createTask("next prompt"), 101)).toBe(0);
	});
	test("disagreements trigger repair then escalation; partial failure is usable, all failures are not a pass", () => {
		expect(nextAction("draft", [pass, revise])).toBe("repair");
		expect(nextAction("repair", [pass, revise])).toBe("escalate");
		expect(nextAction("draft", [pass, { model: "b", error: "timeout" }])).toBe("pass");
		expect(nextAction("draft", [{ model: "b", error: "timeout" }])).toBe("escalate");
	});
	test("rejects malformed and contradictory verdicts", () => {
		for (const text of ["no", "null", "{}", '{"verdict":"pass","findings":["bug"],"checks":[]}', '{"verdict":"revise","findings":[],"checks":[]}']) expect(() => parseVerdict(text)).toThrow();
		expect(parseVerdict('```json\n{"verdict":"pass","findings":[],"checks":[]}\n```').verdict).toBe("pass");
	});
	test("keeps all conversation text without an aggregate cap, but truncates each tool item", () => {
		const user = "full user text".repeat(6000);
		const assistant = "full assistant text".repeat(6000);
		const messages = [
			{ role: "user", content: user },
			{ role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning", thinkingSignature: "opaque signature" }, { type: "text", text: assistant }, { type: "toolCall", id: "call-1", name: "custom_tool", arguments: { query: "x".repeat(20000) } }] },
			{ role: "toolResult", toolCallId: "call-1", toolName: "custom_tool", isError: true, content: [{ type: "text", text: "y".repeat(20000) }, { type: "image", data: "private image" }] },
			{ role: "user", content: [{ type: "text", text: "continue" }] },
		];
		const packet = evidencePacket(messages, "review target".repeat(5000));
		expect(packet.length).toBeGreaterThan(48000);
		expect(packet).toContain(user);
		expect(packet).toContain(assistant);
		expect(packet).toContain("USER\ncontinue");
		expect(packet).toContain("TOOL CALL custom_tool (call-1)");
		expect(packet).toContain("TOOL RESULT custom_tool (call-1); error: true");
		expect(packet).toContain("review target".repeat(5000));
		for (const excluded of ["secret reasoning", "opaque signature", "private image", "x".repeat(TOOL_ARGUMENT_CHARS), "y".repeat(TOOL_RESULT_CHARS)]) expect(packet).not.toContain(excluded);
		expect(packet.match(/\[\.\.\. truncated \.\.\.\]/g)).toHaveLength(2);
		const parameters = packet.split("TOOL CALL custom_tool (call-1)\n")[1].split("\n\nTOOL RESULT")[0];
		const result = packet.split("TOOL RESULT custom_tool (call-1); error: true\n")[1].split("\n\nUSER")[0];
		expect(parameters.length).toBe(1000);
		expect(result.length).toBe(1000);
	});
	test("loads defaults without a config and rejects configuration errors", async () => {
		expect((await loadConfig("/tmp/nonexistent-fusion-config-123456789.json")).actor.model).toBe("gpt-5.6-luna");
		for (const value of [null, [], { mystery: 1 }, { reviewers: [] }, { timeoutMs: -1 }, { maxTokens: 0 }, { reviewEveryToolCalls: 0 }, { reviewEveryToolCalls: 1.5 }, { reviewEveryToolCalls: 1001 }, { actor: { provider: "x", model: "y", reasoning: "bogus" } }, { reviewers: [{ provider: "x", model: "y" }, { provider: "x", model: "y" }] }]) expect(() => parseConfig(value)).toThrow();
		expect(parseConfig({}).reviewEveryToolCalls).toBe(10);
		expect(parseConfig({ reviewEveryToolCalls: 7 }).reviewEveryToolCalls).toBe(7);
		expect(parseConfig({ frontier: { provider: "local", model: "custom" } }).frontier.reasoning).toBe("low");
	});
});
