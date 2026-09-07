import { expect, mock, test } from "bun:test";
let complete: (...args: any[]) => Promise<any>;
mock.module("@earendil-works/pi-ai/compat", () => ({ completeSimple: (...args: any[]) => complete(...args) }));
const { requestAdvice, REVIEW_PROMPT } = await import("./requests.ts");
const { DEFAULT_CONFIG } = await import("./config.ts");
const ctx: any = { modelRegistry: {
	find: () => ({ provider: "test", id: "reviewer" }),
	getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret-never-log" }),
} };

test("advisory options omit an output token cap", async () => {
	complete = async (_model, _context, options) => {
		expect(options).not.toHaveProperty("maxTokens");
		return { content: [{ type: "text", text: "advice" }], stopReason: "stop", usage: {} };
	};
	await requestAdvice(ctx, DEFAULT_CONFIG.reviewers[0], DEFAULT_CONFIG, REVIEW_PROMPT, "evidence", new AbortController().signal);
});

test("deadline cancels a provider that never settles", async () => {
	let signal: AbortSignal | undefined;
	complete = async (_model, _context, options) => {
		signal = options.signal;
		return new Promise(() => {});
	};
	await expect(requestAdvice(ctx, DEFAULT_CONFIG.reviewers[0], { ...DEFAULT_CONFIG, timeoutMs: 10 }, REVIEW_PROMPT, "evidence", new AbortController().signal)).rejects.toThrow("deadline");
	expect(signal?.aborted).toBe(true);
});

test("deadline also bounds auth lookup and never starts a late provider request", async () => {
	let release: (value: unknown) => void = () => {};
	let calls = 0;
	const authContext: any = { modelRegistry: { ...ctx.modelRegistry, getApiKeyAndHeaders: () => new Promise((resolve) => { release = resolve; }) } };
	complete = async () => { calls++; };
	await expect(requestAdvice(authContext, DEFAULT_CONFIG.reviewers[0], { ...DEFAULT_CONFIG, timeoutMs: 10 }, REVIEW_PROMPT, "evidence", new AbortController().signal)).rejects.toThrow("deadline");
	release({ ok: true, apiKey: "secret-never-log" });
	await Promise.resolve();
	expect(calls).toBe(0);
});

test("already-cancelled requests never call inference", async () => {
	let calls = 0;
	complete = async () => { calls++; };
	const controller = new AbortController(); controller.abort(new Error("cancelled"));
	await expect(requestAdvice(ctx, DEFAULT_CONFIG.reviewers[0], DEFAULT_CONFIG, REVIEW_PROMPT, "evidence", controller.signal)).rejects.toThrow("cancelled");
	expect(calls).toBe(0);
});

test.each(["error", "aborted", "length", "toolUse"])("%s is not successful advice", async (stopReason) => {
	complete = async () => ({ content: [{ type: "text", text: "partial" }], stopReason });
	await expect(requestAdvice(ctx, DEFAULT_CONFIG.reviewers[0], DEFAULT_CONFIG, REVIEW_PROMPT, "evidence", new AbortController().signal)).rejects.toThrow(stopReason);
});
