import { expect, test } from "bun:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { defaultConfig } from "./config.ts";
import type { Registry } from "./provider.ts";
import { MixtureSession, newState } from "./session.ts";

const registry: Registry = {
	find: (provider, id) => ({ provider, id, name: id, api: "fixture", baseUrl: "", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
	getProvider: () => undefined,
	getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
};

const result = (id: string, name: string, details?: Record<string, unknown>): ToolResultMessage => ({
	role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }],
	isError: false, timestamp: Date.now(), details,
});

test("mocked background writer retains its lease until explicit stop, then lead can take over", async () => {
	const preset = structuredClone(defaultConfig().presets.default);
	preset.reviewers = [];
	const state = newState("default", preset);
	const background = { sessionId: "root", available: true, jobs: [] as Array<{ id: string; status: "running" | "exited" | "killed"; cwd: string; ownerSessionId: string }> };
	const session = new MixtureSession(preset, registry, state, () => background);
	session.newRequest("Run and stop the bounded fixture job.");

	state.origins.delegate = { actor: "lead", synthetic: false };
	await session.control("delegate", {
		action: "delegate", task: "Run and stop the bounded fixture job",
		nextAction: "Launch the fixture job, then stop it before reporting",
		successCriteria: ["The job is stopped before handoff"],
	});
	expect(state.owner).toBe("writer");

	state.origins.start = { actor: "writer", synthetic: false };
	background.jobs.push({ id: "job-1", status: "running", cwd: "/fixture", ownerSessionId: "root" });
	session.completeTurn([result("start", "bash", { job: background.jobs[0] })]);
	expect(state.jobs).toEqual({ "job-1": "writer" });
	state.origins.early = { actor: "writer", synthetic: false };
	await expect(session.control("early", { action: "report", report: "Handing back early" }))
		.rejects.toThrow("running tracked jobs: job-1");
	expect(state.owner).toBe("writer");

	state.origins.stop = { actor: "writer", synthetic: false };
	expect(() => session.guard("stop", "bg_process", { action: "kill", id: "job-1" })).not.toThrow();
	background.jobs[0]!.status = "killed";
	session.completeTurn([result("stop", "bg_process", { job: background.jobs[0] })]);
	expect(state.jobs).toEqual({});
	state.origins.report = { actor: "writer", synthetic: false };
	await session.control("report", { action: "report", report: "Stopped the job." });
	expect(state.owner).toBeUndefined();

	state.origins.takeover = { actor: "lead", synthetic: false };
	await session.control("takeover", { action: "takeover" });
	expect(state.owner).toBe("lead");
	state.origins.write = { actor: "lead", synthetic: false };
	expect(() => session.guard("write", "write", { path: "output.txt", content: "lead owns the lease\n" })).not.toThrow();
});
