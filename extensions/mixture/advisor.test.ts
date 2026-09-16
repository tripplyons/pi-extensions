import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { advisorCallCount, advisorGuidelines, consultAdvisor, recentConversation, repositoryContext } from "./advisor.ts";
import { defaultAdvisorPreset, MIN_ADVISOR_INTERVAL_MS } from "./config.ts";
import { emitMessage, emptyUsage, type Registry } from "./provider.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const model = (id: string) => ({ provider: "fixture", id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: emptyUsage().cost });

test("recent conversation is bounded by complete entries and redacts common secrets", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "old context" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "API_TOKEN=secret-value" } }] } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "Bearer abc.def.ghi" }] } },
	];
	const full = recentConversation(entries, 10_000, true);
	expect(full).not.toContain("secret-value");
	expect(full).not.toContain("abc.def.ghi");
	expect(full).toContain("[REDACTED]");
	const bounded = recentConversation(entries, 120, true);
	expect(bounded.length).toBeLessThanOrEqual(120);
	expect(bounded).toContain("omitted");
});

test("repository context respects off, summary, full, and the character cap", () => {
	const cwd = mkdtempSync(join(tmpdir(), "mixture-advisor-git-")); directories.push(cwd);
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, "fixture.txt"), "before\n");
	execFileSync("git", ["add", "fixture.txt"], { cwd });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
	writeFileSync(join(cwd, "fixture.txt"), "after\n");
	expect(repositoryContext(cwd, "off", 1_000, true)).toContain("disabled");
	const summary = repositoryContext(cwd, "summary", 1_000, true);
	expect(summary).toContain("fixture.txt");
	expect(summary).not.toContain("+after");
	const full = repositoryContext(cwd, "full", 10_000, true);
	expect(full).toContain("+after");
	expect(repositoryContext(cwd, "full", 40, true).length).toBeLessThanOrEqual(40);
});

test("consultation calls only the configured advisor, carries usage, and enforces the persisted call budget", async () => {
	const preset = defaultAdvisorPreset();
	preset.advisor = { model: "fixture/advisor", thinking: "high" };
	const calls: any[] = [];
	const registry: Registry = {
		find: (_provider, id) => model(id) as any,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
		getProvider: () => ({ streamSimple: (selected: any, context: any, options: any) => {
			calls.push({ selected, context, options });
			const stream = createAssistantMessageEventStream();
			emitMessage(stream, { role: "assistant", provider: selected.provider, model: selected.id, api: selected.api, content: [{ type: "text", text: "Review the boundary condition." }], usage: { ...emptyUsage(), input: 20, output: 5, totalTokens: 25 }, stopReason: "stop", timestamp: 1 });
			return stream;
		} }) as any,
	};
	const branch: any[] = [{ type: "message", message: { role: "user", content: "Fix the parser" } }];
	const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => branch, getSessionId: () => "root" } } as any;
	const result = await consultAdvisor(preset, registry, { draft: "The tests pass" }, ctx);
	expect(result.text).toBe("Review the boundary condition.");
	expect(result.usage.totalTokens).toBe(25);
	expect(calls).toHaveLength(1);
	expect(calls[0].selected.id).toBe("advisor");
	expect(calls[0].context.tools).toEqual([]);
	expect(calls[0].context.systemPrompt).toContain("cannot call tools");
	expect(calls[0].options.reasoning).toBe("high");
	branch.push({ type: "message", message: { role: "toolResult", toolName: "ask_advisor", content: [{ type: "text", text: result.text }], timestamp: Date.now() } });
	expect(advisorCallCount(branch)).toBe(1);
	await expect(consultAdvisor(preset, registry, {}, ctx)).rejects.toThrow("throttled");
	(branch[1]!.message as any).timestamp = Date.now() - MIN_ADVISOR_INTERVAL_MS - 1;
	const second = await consultAdvisor(preset, registry, {}, ctx);
	expect(second.text).toBe("Review the boundary condition.");
	expect(calls).toHaveLength(2);
	expect(advisorGuidelines(preset, 1).join("\n")).toContain("one-minute rate limit");
	expect(advisorGuidelines(preset, 1).join("\n")).toContain("every 5 minutes");
});
