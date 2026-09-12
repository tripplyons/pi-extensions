import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMixtureExtension } from "./index.ts";
import { emptyUsage } from "./state.ts";

test("mixture's completion scanner wakes a pending bg-bash sleep without idle delivery", async () => {
	const previousCache = process.env.XDG_CACHE_HOME;
	const cache = mkdtempSync(join(tmpdir(), "mixture-wake-"));
	process.env.XDG_CACHE_HOME = cache;
	const { default: bgBash } = await import("../bg-bash/index.ts");
	const bus = new EventEmitter();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const messages: any[] = [];
	let active: string[] = [];
	const pi: any = {
		events: {
			on(name: string, fn: (...args: any[]) => void) { bus.on(name, fn); return () => bus.off(name, fn); },
			emit(name: string, value: unknown) { bus.emit(name, value); },
		},
		on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerMessageRenderer() {},
		getActiveTools: () => active,
		setActiveTools(names: string[]) { active = names; },
		sendMessage(message: any) { messages.push(message); },
	};
	const attempt = { attempt: 1, status: "running", usage: emptyUsage() };
	const run: any = { id: "mix_wake", workers: [{ id: "slot-0", attempts: [attempt] }] };
	const ctx: any = { sessionManager: { getSessionId: () => "wake-test", getEntries: () => [] }, ui: { notify() {} } };
	bgBash(pi);
	createMixtureExtension(pi, { reconnectRuns() {}, sessionRuns: () => [run] } as any);
	const abort = new AbortController();
	try {
		for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
		await commands.get("mixture").handler("", ctx);
		const sleeping = tools.get("sleep").execute("sleep", { seconds: 10 }, abort.signal);
		attempt.status = "ok";
		const result = await sleeping;
		expect(result.details.asyncJob).toEqual({ source: "mixture", id: "mix_wake/slot-0/1", status: "exited" });
		expect(result.details.sleptSeconds).toBeLessThan(3);
		expect(messages).toHaveLength(1);
	} finally {
		abort.abort();
		for (const fn of handlers.get("session_shutdown") ?? []) await fn({}, ctx);
		rmSync(cache, { recursive: true, force: true });
		if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = previousCache;
	}
	expect(bus.listenerCount("tripp:async-job-completed")).toBe(0);
});
