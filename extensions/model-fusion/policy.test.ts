import { describe, expect, test } from "bun:test";
import { loadConfig, parseConfig } from "./config.ts";
import { addEvidence, COOLDOWN_MS, createTask, evidencePacket, nextAction, PACKET_CHARS, parseVerdict, reserveEscalation } from "./policy.ts";

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
	test("bounds evidence and packet while retaining recent output and task/candidate", () => {
		const task = createTask("task".repeat(10_000));
		for (let index = 0; index < 20; index++) addEvidence(task, `${index}:` + "e".repeat(20_000));
		const packet = evidencePacket(task, "candidate".repeat(10_000));
		expect(packet.length).toBeLessThanOrEqual(PACKET_CHARS);
		expect(packet).toContain("19:");
		expect(packet).toContain("truncated");
		expect(packet).toContain("TASK");
		expect(packet).toContain("CANDIDATE");
		expect(task.evidence.join("").length).toBeLessThanOrEqual(32_000);
	});
	test("loads defaults without a config and rejects configuration errors", async () => {
		expect((await loadConfig("/tmp/nonexistent-fusion-config-123456789.json")).actor.model).toBe("gpt-5.6-luna");
		for (const value of [null, [], { mystery: 1 }, { reviewers: [] }, { timeoutMs: -1 }, { maxTokens: 0 }, { reviewEveryToolCalls: 0 }, { reviewEveryToolCalls: 1.5 }, { reviewEveryToolCalls: 1001 }, { actor: { provider: "x", model: "y", reasoning: "bogus" } }, { reviewers: [{ provider: "x", model: "y" }, { provider: "x", model: "y" }] }]) expect(() => parseConfig(value)).toThrow();
		expect(parseConfig({}).reviewEveryToolCalls).toBe(10);
		expect(parseConfig({ reviewEveryToolCalls: 7 }).reviewEveryToolCalls).toBe(7);
		expect(parseConfig({ frontier: { provider: "local", model: "custom" } }).frontier.reasoning).toBe("low");
	});
});
