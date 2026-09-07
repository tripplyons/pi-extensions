import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[]) => ({ type: "string", enum: [...values] }),
}));
mock.module("@earendil-works/pi-coding-agent", () => {
	const truncate = (content: string, options: { maxLines?: number; maxBytes?: number } = {}, keep: "head" | "tail") => {
		const maxLines = options.maxLines ?? 2_000;
		const maxBytes = options.maxBytes ?? 50 * 1024;
		const original = content.split("\n");
		let lines = keep === "head" ? original.slice(0, maxLines) : original.slice(-maxLines);
		while (lines.length > 0 && Buffer.byteLength(lines.join("\n"), "utf8") > maxBytes) {
			if (keep === "head") lines.pop();
			else lines.shift();
		}
		const output = lines.join("\n");
		return {
			content: output,
			truncated: output !== content,
			truncatedBy: original.length > maxLines ? "lines" : Buffer.byteLength(content, "utf8") > maxBytes ? "bytes" : null,
			totalLines: original.length,
			totalBytes: Buffer.byteLength(content, "utf8"),
			outputLines: lines.length,
			outputBytes: Buffer.byteLength(output, "utf8"),
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	};
	return {
		DEFAULT_MAX_BYTES: 50 * 1024,
		DEFAULT_MAX_LINES: 2_000,
		formatSize: (bytes: number) => bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`,
		truncateHead: (content: string, options?: { maxLines?: number; maxBytes?: number }) => truncate(content, options, "head"),
		truncateTail: (content: string, options?: { maxLines?: number; maxBytes?: number }) => truncate(content, options, "tail"),
	};
});
mock.module("typebox", () => ({
	Type: {
		Array: (items: object, options: object = {}) => ({ type: "array", items, ...options }),
		Boolean: (options: object = {}) => ({ type: "boolean", ...options }),
		Number: (options: object = {}) => ({ type: "number", ...options }),
		Object: (properties: object) => ({ type: "object", properties }),
		Optional: (schema: object) => schema,
		String: (options: object = {}) => ({ type: "string", ...options }),
	},
}));
mock.module("@earendil-works/pi-tui", () => ({
	Text: class {
		constructor(public text: string) {}
		render() { return [this.text]; }
		invalidate() {}
	},
	matchesKey: (data: string, key: string) => {
		const keys: Record<string, string[]> = {
			escape: ["\u001b"],
			up: ["\u001b[A"],
			down: ["\u001b[B"],
			left: ["\u001b[D"],
			right: ["\u001b[C"],
			home: ["\u001b[H"],
			end: ["\u001b[F"],
			pageUp: ["\u001b[5~"],
			pageDown: ["\u001b[6~"],
		};
		return keys[key]?.includes(data) ?? false;
	},
	truncateToWidth: (value: string, width: number, ellipsis = "...", pad = false) => {
		const clipped = value.length > width ? value.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis : value;
		return pad ? clipped.padEnd(width, " ") : clipped;
	},
}));
mock.module("../tool-status-style/style.ts", () => ({
	withStatusCard: (definition: object) => definition,
}));

const { createAgentSwarmExtension } = await import("./index.ts");
const { SwarmTreeView, buildTreeRows, formatDuration, isEscalatedStaleWorker, isStaleWorker, STALE_WORKER_ESCALATE_MS, STALE_WORKER_THRESHOLD_MS } = await import("./tree-ui.ts");

type Timer = {
	callback: () => void;
	cancelled: boolean;
	delayMs: number;
};

const createTimerHarness = () => {
	const timers: Timer[] = [];
	return {
		scheduleTimer(callback: () => void, delayMs: number) {
			const timer = { callback, cancelled: false, delayMs };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		},
		run(includeCancelled = false) {
			for (const timer of timers.splice(0)) {
				if (includeCancelled || !timer.cancelled) timer.callback();
			}
		},
		pending() {
			return timers.filter((timer) => !timer.cancelled);
		},
	};
};

const createHarness = (
	existingStateRoot?: string,
	cwdOverride?: string,
	sessionId = "session-test",
	dependencies: { now?: () => number; scheduleTimer?: (callback: () => void, delayMs: number) => () => void } = {},
) => {
	// Never let the developer's active worker identity leak into a root harness.
	for (const name of ["PI_SWARM_WORKER", "PI_SWARM_RUN_ID", "PI_SWARM_NODE_ID", "PI_SWARM_PARENT_ID", "PI_SWARM_HOME", "PI_SWARM_CODEX_FAST_MODE"]) {
		delete process.env[name];
	}
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const events = new Map<string, (value: unknown) => void>();
	const emissions: Array<{ name: string; value: any }> = [];
	const lifecycle = new Map<string, (event?: any, ctx?: any) => unknown>();
	const messageRenderers = new Map<string, any>();
	const messages: any[] = [];
	const sentMessages: Array<{ message: any; options?: unknown }> = [];
	const userMessages: Array<{ content: string; options?: unknown }> = [];
	const notifications: Array<{ text: string; level: string }> = [];
	const sessionEntries: unknown[] = [];
	let activeTools = ["read", "ask_user", "unrelated_tool"];
	const pi = {
		on(name: string, handler: (event?: any, ctx?: any) => unknown) { lifecycle.set(name, handler); },
		events: {
			on(name: string, handler: (value: unknown) => void) { events.set(name, handler); return () => events.delete(name); },
			emit(name: string, value: unknown) { emissions.push({ name, value }); events.get(name)?.(value); },
		},
		registerCommand(name: string, definition: object) { commands.set(name, definition); },
		registerTool(definition: any) {
			tools.set(definition.name, definition);
			activeTools = [...new Set([...activeTools, definition.name])];
		},
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) { activeTools = [...names]; },
		registerMessageRenderer(name: string, renderer: any) { messageRenderers.set(name, renderer); },
		sendMessage(message: unknown, options?: unknown) { messages.push(message); sentMessages.push({ message, options }); },
		sendUserMessage(content: string, options?: unknown) { userMessages.push({ content, options }); },
	};
	createAgentSwarmExtension(pi as any, dependencies);
	const stateRoot = existingStateRoot ?? mkdtempSync(join(tmpdir(), "pi-agent-swarm-test-"));
	process.env.PI_SWARM_HOME = stateRoot;
	const context = {
		cwd: cwdOverride ?? stateRoot,
		hasUI: false,
		model: { provider: "test", id: "model" },
		thinkingLevel: "low",
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => sessionId, getEntries: () => sessionEntries },
		ui: { notify(text: string, level: string) { notifications.push({ text, level }); }, setStatus() {}, theme: { fg: (_role: string, text: string) => text } },
	};
	return { commands, tools, events, emissions, lifecycle, messageRenderers, messages, sentMessages, userMessages, notifications, sessionEntries, context, stateRoot, activeTools: () => [...activeTools] };
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `\'"'"'`)}'`;

const createReadyWorker = (directory: string) => {
	const path = join(directory, "ready-worker.sh");
	const code = [
		`const fs = require("fs");`,
		`const path = require("path");`,
		`const file = path.join(process.env.PI_SWARM_HOME, "runs", process.env.PI_SWARM_RUN_ID, "nodes", process.env.PI_SWARM_NODE_ID + ".json");`,
		`const node = JSON.parse(fs.readFileSync(file, "utf8"));`,
		`fs.writeFileSync(path.join(process.env.PI_SWARM_HOME, process.env.PI_SWARM_NODE_ID + ".launch.json"), JSON.stringify({ args: process.argv.slice(1), fastMode: process.env.PI_SWARM_CODEX_FAST_MODE }));`,
		`node.status = "ready"; node.readyAt = Date.now(); node.version++; node.updatedAt = Date.now();`,
		`fs.writeFileSync(file, JSON.stringify(node));`,
	].join(" ");
	writeFileSync(path, `#!/bin/sh\n${shellQuote(process.execPath)} -e ${shellQuote(code)} -- "$@"\nsleep 30\n`, { mode: 0o700 });
	return path;
};

const treeTheme = {
	fg: (_color: string, text: string) => text,
	bgColors: { selectedBg: (text: string) => text },
	bg(color: string, text: string) { return this.bgColors[color as keyof typeof this.bgColors]?.(text) ?? text; },
	bold: (text: string) => text,
};

const treeTui = (columns = 100, rows = 16) => ({
	terminal: { columns, rows },
	requestRender() {},
});

const makeTreeNode = (nodeId: string, parentId: string | null, status = "running") => ({
	schemaVersion: 1,
	runId: "run_test",
	nodeId,
	parentId,
	childIds: [] as string[],
	role: parentId === null ? "root" : "worker",
	task: `${nodeId} task`,
	status,
	version: 1,
	createdAt: Date.now(),
	updatedAt: Date.now(),
	sessionId: null,
	sessionName: nodeId,
	cwd: "/tmp",
	worktreePath: null,
	branch: null,
	sharedDirectory: true,
	tmuxSession: null,
	tmuxWindow: null,
	model: null,
	thinking: null,
	result: null,
	resultMessageId: null,
	review: null,
	reviewMessageId: null,
	failure: null,
	readyAt: null,
	cleanedAt: null,
});

const attachActiveChild = async (harness: ReturnType<typeof createHarness>) => {
	harness.context.isIdle = () => true;
	harness.context.hasPendingMessages = () => false;
	await harness.commands.get("swarm:start").handler("root", harness.context);
	const index = JSON.parse(readFileSync(join(harness.stateRoot, "sessions", "session-test.json"), "utf8"));
	const runPath = join(harness.stateRoot, "runs", index.runId);
	const rootPath = join(runPath, "nodes", `${index.nodeId}.json`);
	const root = JSON.parse(readFileSync(rootPath, "utf8"));
	const child = { ...makeTreeNode("node_child", index.nodeId), runId: index.runId };
	root.childIds = [child.nodeId];
	writeFileSync(rootPath, `${JSON.stringify(root)}\n`);
	writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);
	return { child, index, root, rootPath, runPath };
};

const compactEvent = (reason: "manual" | "threshold" | "overflow", willRetry = false) => ({
	reason,
	willRetry,
	compactionEntry: { id: `${reason}-compaction` },
});

const agentEndEvent = (stopReason: "aborted" | "error" | "length" | "stop") => ({
	messages: [{ role: "assistant", stopReason }],
});

const git = (cwd: string, ...args: string[]) => {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
};

describe("activation and hierarchy gate", () => {
	test("registers colon slash commands and rejects the old space-separated form", async () => {
		const harness = createHarness();
		try {
			expect([...harness.commands.keys()]).toEqual(["swarm:start", "swarm:tree", "swarm:status", "swarm:pause", "swarm:resume", "swarm:runs", "swarm:kill", "swarm:clear", "swarm:help"]);
			expect(harness.commands.has("swarm")).toBe(false);
			expect(harness.commands.get("swarm:start").description).toContain("/swarm:start");
			expect(harness.commands.get("swarm:tree").description).not.toContain("/swarm tree");
			expect(harness.tools.get("swarm_spawn").promptGuidelines.join("\n")).toContain("direct parent with swarm_send");
			expect(harness.tools.get("swarm_spawn").promptGuidelines.join("\n")).toContain("instead of prompting in its hidden pane");
			await harness.commands.get("swarm:help").handler("", harness.context);
			expect(harness.notifications.at(-1)?.text).toContain("/swarm:start");
			expect(harness.notifications.at(-1)?.text).toContain("/swarm:tree");
			expect(harness.notifications.at(-1)?.text).toContain("colon syntax");
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("activates without an objective and exposes a single-use objective tool", async () => {
		const harness = createHarness();
		try {
			await harness.lifecycle.get("session_start")?.({}, harness.context);
			const spawn = harness.tools.get("swarm_spawn");
			const setObjective = harness.tools.get("swarm_set_objective");
			expect(harness.activeTools()).not.toContain("swarm_set_objective");
			expect(setObjective.promptGuidelines.join("\n")).toContain("ask_user");
			await expect(spawn.execute("call", { task: "child task" }, undefined, undefined, harness.context)).rejects.toThrow("/swarm:start");

			await harness.commands.get("swarm:start").handler("", harness.context);
			expect(harness.notifications.every((notification) => notification.level !== "error"), JSON.stringify(harness.notifications)).toBe(true);
			expect(harness.activeTools()).toContain("swarm_set_objective");
			for (const name of ["read", "ask_user", "unrelated_tool", "swarm_spawn"]) expect(harness.activeTools()).toContain(name);

			const indexPath = join(harness.stateRoot, "sessions", "session-test.json");
			const index = JSON.parse(readFileSync(indexPath, "utf8"));
			const rootPath = join(harness.stateRoot, "runs", index.runId, "nodes", `${index.nodeId}.json`);
			expect(JSON.parse(readFileSync(rootPath, "utf8")).task).toBe("");

			const beforeRepeat = readFileSync(rootPath, "utf8");
			const notificationCount = harness.notifications.length;
			const emissionCount = harness.emissions.length;
			const activeTools = harness.activeTools();
			await harness.commands.get("swarm:start").handler("must be ignored", harness.context);
			expect(readFileSync(rootPath, "utf8")).toBe(beforeRepeat);
			expect(harness.notifications).toHaveLength(notificationCount);
			expect(harness.emissions).toHaveLength(emissionCount);
			expect(harness.activeTools()).toEqual(activeTools);

			await expect(setObjective.execute("call", { objective: "   " }, undefined, undefined, harness.context)).rejects.toThrow("cannot be empty");
			expect(harness.activeTools()).toContain("swarm_set_objective");
			const [firstAssignment, competingAssignment] = await Promise.allSettled([
				setObjective.execute("call-1", { objective: "  Ship the swarm change  " }, undefined, undefined, harness.context),
				setObjective.execute("call-2", { objective: "Replacement" }, undefined, undefined, harness.context),
			]);
			expect(firstAssignment.status).toBe("fulfilled");
			expect(competingAssignment.status).toBe("rejected");
			if (firstAssignment.status !== "fulfilled") throw firstAssignment.reason;
			expect(firstAssignment.value.content[0].text).toContain("Ship the swarm change");
			expect(harness.activeTools()).not.toContain("swarm_set_objective");
			for (const name of ["read", "ask_user", "unrelated_tool", "swarm_spawn"]) expect(harness.activeTools()).toContain(name);
			const root = JSON.parse(readFileSync(rootPath, "utf8"));
			expect(root.task).toBe("Ship the swarm change");
			expect(root.version).toBe(2);
			const task = await harness.tools.get("swarm_task").execute("call", {}, undefined, undefined, harness.context);
			expect(task.content[0].text).toBe("Ship the swarm change");
			const tree = await harness.tools.get("swarm_tree").execute("call", {}, undefined, undefined, harness.context);
			expect(tree.content[0].text).toContain("task=Ship the swarm change");
			await expect(setObjective.execute("call", { objective: "Replacement" }, undefined, undefined, harness.context)).rejects.toThrow("already set");
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("keeps inline objective activation compatible", async () => {
		const harness = createHarness();
		try {
			await harness.commands.get("swarm:start").handler("root task", harness.context);
			expect(harness.activeTools()).not.toContain("swarm_set_objective");
			const task = await harness.tools.get("swarm_task").execute("call", {}, undefined, undefined, harness.context);
			expect(task.content[0].text).toBe("root task");
			expect(await Bun.file(join(harness.stateRoot, "sessions", "session-test.json")).exists()).toBe(true);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("previews sent and received swarm message content", () => {
		const harness = createHarness();
		try {
			const send = harness.tools.get("swarm_send");
			const body = "Please inspect the worker output and report the failing test.";
			const call = send.renderCall({ target: "node_child", kind: "instruction", body }, treeTheme);
			expect(call.render(240).join("\n")).toContain(`instruction → node_child: ${body}`);

			const queued = send.renderResult({ content: [{ type: "text", text: `Queued instruction msg_1 for node_child: ${body}` }] }, { expanded: false }, treeTheme);
			expect(queued.render(240).join("\n")).toContain(body);
			const fullBody = `${body} ${"x".repeat(200)}`;
			const expandedQueued = send.renderResult({ content: [{ type: "text", text: fullBody }] }, { expanded: true }, treeTheme);
			expect(expandedQueued.render(400).join("\n")).toBe(fullBody);

			const renderer = harness.messageRenderers.get("agent-swarm-inbox");
			const received = renderer({
				content: `[agent-swarm instruction msg_1] from node_child\n${fullBody}`,
				details: { messageId: "msg_1", fromNodeId: "node_child", toNodeId: "node_root", kind: "instruction", body: fullBody },
			}, { expanded: false }, treeTheme);
			const preview = received.render(240).join("\n");
			expect(preview).toContain("← instruction");
			expect(preview).toContain("node_child → node_root");
			expect(preview).toContain(body);
			expect(preview).toContain("…");
			expect(preview.length).toBeLessThan(fullBody.length);
			const expandedReceived = renderer({
				content: `[agent-swarm instruction msg_1] from node_child\n${fullBody}`,
				details: { messageId: "msg_1", fromNodeId: "node_child", toNodeId: "node_root", kind: "instruction", body: fullBody },
			}, { expanded: true }, treeTheme);
			expect(expandedReceived.render(400).join("\n")).toContain(fullBody);
		} finally {
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("previews completion results and review feedback without changing inbox previews", () => {
		const harness = createHarness();
		try {
			const complete = harness.tools.get("swarm_complete");
			const result = "Implemented the worker changes and verified the focused tests.";
			const completeSummary = "Submitted msg_result for review by node_parent";
			const completePreview = complete.renderResult({
				content: [{ type: "text", text: completeSummary }],
				details: { messageId: "msg_result", toNodeId: "node_parent", kind: "result", body: result },
			}, { expanded: false }, treeTheme);
			expect(completePreview.render(240).join("\n")).toContain(result);
			const expandedComplete = complete.renderResult({
				content: [{ type: "text", text: completeSummary }],
				details: { messageId: "msg_result", toNodeId: "node_parent", kind: "result", body: `${result}\nSecond line` },
			}, { expanded: true }, treeTheme);
			expect(expandedComplete.render(240).join("\n")).toContain(`${result}\nSecond line`);

			const review = harness.tools.get("swarm_review");
			const feedback = "Please add the regression coverage before accepting this handoff.";
			const reviewResult = "The implementation is ready for review.";
			const reviewPreview = review.renderResult({
				content: [{ type: "text", text: "node_child rework" }],
				details: {
					action: "request-changes",
					node: {
						nodeId: "node_child",
						status: "rework",
						result: { text: reviewResult },
						review: { action: "request-changes", feedback },
					},
				},
			}, { expanded: false }, treeTheme);
			const reviewText = reviewPreview.render(240).join("\n");
			expect(reviewText).toContain(reviewResult);
			expect(reviewText).toContain(feedback);
			const expandedReview = review.renderResult({
				content: [{ type: "text", text: "node_child rework" }],
				details: {
					action: "request-changes",
					node: {
						nodeId: "node_child",
						status: "rework",
						result: { text: reviewResult },
						review: { action: "request-changes", feedback: `${feedback}\nSecond feedback line` },
					},
				},
			}, { expanded: true }, treeTheme);
			const expandedReviewText = expandedReview.render(240).join("\n");
			expect(expandedReviewText).toContain(reviewResult);
			expect(expandedReviewText).toContain(`${feedback}\nSecond feedback line`);
			const longFeedback = "feedback ".repeat(40);
			const longResult = "result ".repeat(40);
			const collapsedLongReview = review.renderResult({
				content: [{ type: "text", text: "node_child rework" }],
				details: { action: "request-changes", node: { nodeId: "node_child", status: "rework", result: { text: longResult }, review: { feedback: longFeedback } } },
			}, { expanded: false }, treeTheme).render(240).join("\n");
			expect(collapsedLongReview.length).toBeLessThanOrEqual(160);
			expect(collapsedLongReview).toContain("Result:");
			expect(collapsedLongReview).toContain("Feedback:");
			expect(collapsedLongReview).toContain("…");
			const expandedLongReview = review.renderResult({
				content: [{ type: "text", text: "node_child rework" }],
				details: { action: "request-changes", node: { nodeId: "node_child", status: "rework", result: { text: longResult }, review: { feedback: longFeedback } } },
			}, { expanded: true }, treeTheme).render(240).join("\n");
			expect(expandedLongReview).toContain(longResult);
			expect(expandedLongReview).toContain(longFeedback);

			const send = harness.tools.get("swarm_send");
			const sendResult = send.renderResult({
				content: [{ type: "text", text: "Queued message msg_send for node_child: keep inbox behavior" }],
				details: { body: "keep inbox behavior" },
			}, { expanded: false }, treeTheme);
			expect(sendResult.render(240).join("\n")).toContain("keep inbox behavior");
		} finally {
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("truncates oversized task and tree output and preserves full artifacts", async () => {
		const harness = createHarness();
		try {
			const largeTask = Array.from({ length: 2_100 }, (_, line) => `${line}-${"t".repeat(30)}`).join("\n");
			await harness.commands.get("swarm:start").handler(largeTask, harness.context);
			const taskResult = await harness.tools.get("swarm_task").execute("call", {}, undefined, undefined, harness.context);
			expect(Buffer.byteLength(taskResult.content[0].text, "utf8")).toBeLessThanOrEqual(50 * 1024);
			expect(taskResult.content[0].text).toContain("Output truncated");
			expect(readFileSync(taskResult.details.artifactPath, "utf8")).toBe(largeTask);
			const index = JSON.parse(readFileSync(join(harness.stateRoot, "sessions", "session-test.json"), "utf8"));
			const runPath = join(harness.stateRoot, "runs", index.runId);
			const rootPath = join(runPath, "nodes", `${index.nodeId}.json`);
			const root = JSON.parse(readFileSync(rootPath, "utf8"));
			for (let childIndex = 0; childIndex < 60; childIndex++) {
				const child = { ...makeTreeNode(`node_child${childIndex}`, index.nodeId, "completed"), runId: index.runId, task: `${childIndex}-${"x".repeat(2_000)}` };
				root.childIds.push(child.nodeId);
				writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);
			}
			writeFileSync(rootPath, `${JSON.stringify(root)}\n`);

			const result = await harness.tools.get("swarm_tree").execute("call", {}, undefined, undefined, harness.context);
			expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThanOrEqual(50 * 1024);
			expect(result.content[0].text).toContain("Output truncated");
			expect(result.details.truncation.truncated).toBe(true);
			expect(result.details.artifactPath).toBeTruthy();
			expect(readFileSync(result.details.artifactPath, "utf8")).toContain("node_child59");
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("keeps a missing objective available on root reconnect", async () => {
		const first = createHarness();
		await first.commands.get("swarm:start").handler("", first.context);
		expect(first.notifications.every((notification) => notification.level !== "error"), JSON.stringify(first.notifications)).toBe(true);
		const index = JSON.parse(readFileSync(join(first.stateRoot, "sessions", "session-test.json"), "utf8"));
		const runPath = join(first.stateRoot, "runs", index.runId, "run.json");
		const originalOwnerToken = JSON.parse(readFileSync(runPath, "utf8")).rootOwnerToken;
		await first.lifecycle.get("session_shutdown")?.({}, first.context);
		const second = createHarness(first.stateRoot);
		try {
			await second.lifecycle.get("session_start")?.({}, second.context);
			const tree = await second.tools.get("swarm_tree").execute("call", {}, undefined, undefined, second.context);
			expect(tree.content[0].text).toContain(index.nodeId);
			expect(second.activeTools()).toContain("swarm_set_objective");
			const reconnectedRun = JSON.parse(readFileSync(runPath, "utf8"));
			expect(reconnectedRun.rootOwnerToken).not.toBe(originalOwnerToken);
			expect(reconnectedRun.rootOwnerPid).toBe(process.pid);
		} finally {
			await first.lifecycle.get("session_shutdown")?.({}, first.context);
			await second.lifecycle.get("session_shutdown")?.({}, second.context);
			rmSync(first.stateRoot, { recursive: true, force: true });
			rmSync(second.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("rejects reconnecting the same root session while another Pi process owns it", async () => {
		const first = createHarness();
		let second: ReturnType<typeof createHarness> | undefined;
		try {
			await first.commands.get("swarm:start").handler("root", first.context);
			const index = JSON.parse(readFileSync(join(first.stateRoot, "sessions", "session-test.json"), "utf8"));
			const runPath = join(first.stateRoot, "runs", index.runId, "run.json");
			const run = JSON.parse(readFileSync(runPath, "utf8"));
			run.rootOwnerPid = process.ppid;
			run.rootHeartbeatAt = Date.now();
			writeFileSync(runPath, `${JSON.stringify(run)}\n`);

			second = createHarness(first.stateRoot);
			await second.lifecycle.get("session_start")?.({}, second.context);
			expect(second.notifications.at(-1)?.level).toBe("error");
			expect(second.notifications.at(-1)?.text).toContain("already active in another Pi process");
			expect(JSON.parse(readFileSync(runPath, "utf8")).rootOwnerToken).toBe(run.rootOwnerToken);
		} finally {
			await first.lifecycle.get("session_shutdown")?.({}, first.context);
			await second?.lifecycle.get("session_shutdown")?.({}, second.context);
			rmSync(first.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("pauses and resumes a swarm from a new Pi session", async () => {
		const first = createHarness();
		let second: ReturnType<typeof createHarness> | undefined;
		try {
			await first.commands.get("swarm:start").handler("root", first.context);
			const index = JSON.parse(readFileSync(join(first.stateRoot, "sessions", "session-test.json"), "utf8"));
			await first.commands.get("swarm:pause").handler("", first.context);
			const pausedRun = JSON.parse(readFileSync(join(first.stateRoot, "runs", index.runId, "run.json"), "utf8"));
			expect(pausedRun.status).toBe("paused");
			expect(first.notifications.at(-1)?.text).toContain(`/swarm:resume ${index.runId}`);

			await first.lifecycle.get("session_shutdown")?.({}, first.context);
			second = createHarness(first.stateRoot, undefined, "session-resumed");
			await second.lifecycle.get("session_start")?.({}, second.context);
			await second.commands.get("swarm:resume").handler(index.runId, second.context);
			expect(second.notifications.at(-1)?.text).toContain("Swarm resumed");
			expect(second.activeTools()).not.toContain("swarm_set_objective");
			const tree = await second.tools.get("swarm_tree").execute("call", {}, undefined, undefined, second.context);
			expect(tree.content[0].text).toContain(index.nodeId);
			expect(await Bun.file(join(first.stateRoot, "sessions", "session-test.json")).exists()).toBe(false);
			expect(await Bun.file(join(first.stateRoot, "sessions", "session-resumed.json")).exists()).toBe(true);
		} finally {
			await first.lifecycle.get("session_shutdown")?.({}, first.context);
			await second?.lifecycle.get("session_shutdown")?.({}, second.context);
			rmSync(first.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("rejects a second live root and permits takeover after the owner shuts down", async () => {
		const first = createHarness();
		let second: ReturnType<typeof createHarness> | undefined;
		try {
			await first.commands.get("swarm:start").handler("root", first.context);
			const index = JSON.parse(readFileSync(join(first.stateRoot, "sessions", "session-test.json"), "utf8"));
			second = createHarness(first.stateRoot, undefined, "session-second");
			await second.lifecycle.get("session_start")?.({}, second.context);

			await second.commands.get("swarm:resume").handler(index.runId, second.context);
			expect(second.notifications.at(-1)?.level).toBe("error");
			expect(second.notifications.at(-1)?.text).toContain("live root session");
			expect(await Bun.file(join(first.stateRoot, "sessions", "session-second.json")).exists()).toBe(false);

			await first.lifecycle.get("session_shutdown")?.({}, first.context);
			await second.commands.get("swarm:resume").handler(index.runId, second.context);
			expect(second.notifications.at(-1)?.text).toContain("Swarm resumed");
			expect(await Bun.file(join(first.stateRoot, "sessions", "session-test.json")).exists()).toBe(false);
			expect(await Bun.file(join(first.stateRoot, "sessions", "session-second.json")).exists()).toBe(true);
		} finally {
			await first.lifecycle.get("session_shutdown")?.({}, first.context);
			await second?.lifecycle.get("session_shutdown")?.({}, second.context);
			rmSync(first.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("announces activation, resume, and clear through the shared activity event", async () => {
		const first = createHarness();
		let second: ReturnType<typeof createHarness> | undefined;
		try {
			await first.commands.get("swarm:start").handler("", first.context);
			expect(first.activeTools()).toContain("swarm_set_objective");
			const index = JSON.parse(readFileSync(join(first.stateRoot, "sessions", "session-test.json"), "utf8"));
			expect(first.emissions.some((emission) => emission.name === "tripp:agent-swarm-activity" && emission.value.kind === "activate" && emission.value.runId === index.runId)).toBe(true);

			await first.commands.get("swarm:pause").handler("", first.context);
			await first.lifecycle.get("session_shutdown")?.({}, first.context);
			second = createHarness(first.stateRoot, undefined, "session-resumed");
			await second.lifecycle.get("session_start")?.({}, second.context);
			await second.commands.get("swarm:resume").handler(index.runId, second.context);
			expect(second.emissions.some((emission) => emission.value.kind === "resume" && emission.value.runId === index.runId)).toBe(true);
			expect(second.activeTools()).toContain("swarm_set_objective");

			await second.commands.get("swarm:clear").handler("", second.context);
			expect(second.emissions.some((emission) => emission.value.kind === "clear" && emission.value.runId === index.runId)).toBe(true);
			expect(second.activeTools()).not.toContain("swarm_set_objective");
		} finally {
			await first.lifecycle.get("session_shutdown")?.({}, first.context);
			await second?.lifecycle.get("session_shutdown")?.({}, second.context);
			rmSync(first.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("routes only direct-parent messages and preserves review transitions", async () => {
		const harness = createHarness();
		const configPath = join(harness.stateRoot, "config.json");
		writeFileSync(configPath, `${JSON.stringify({ pollIntervalMs: 50 })}\n`);
		process.env.PI_SWARM_CONFIG = configPath;
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			const index = JSON.parse(readFileSync(join(harness.stateRoot, "sessions", "session-test.json"), "utf8"));
			const runPath = join(harness.stateRoot, "runs", index.runId);
			const rootPath = join(runPath, "nodes", `${index.nodeId}.json`);
			const root = JSON.parse(readFileSync(rootPath, "utf8"));
			const makeNode = (nodeId: string, parentId: string) => ({
				schemaVersion: 1,
				runId: index.runId,
				nodeId,
				parentId,
				childIds: [],
				role: "worker",
				task: nodeId,
				status: "running",
				version: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				sessionId: null,
				sessionName: nodeId,
				cwd: harness.context.cwd,
				worktreePath: null,
				branch: null,
				sharedDirectory: true,
				tmuxSession: null,
				tmuxWindow: null,
				model: null,
				thinking: null,
				result: null,
				review: null,
				failure: null,
				readyAt: null,
				cleanedAt: null,
			});
			const child = makeNode("node_child", index.nodeId);
			const grandchild = makeNode("node_grandchild", child.nodeId);
			root.childIds = [child.nodeId];
			child.childIds = [grandchild.nodeId];
			writeFileSync(rootPath, `${JSON.stringify(root)}\n`);
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);
			writeFileSync(join(runPath, "nodes", `${grandchild.nodeId}.json`), `${JSON.stringify(grandchild)}\n`);

			const send = harness.tools.get("swarm_send");
			await send.execute("call", { target: child.nodeId, body: "hello" });
			const inbox = join(runPath, "inbox", child.nodeId);
			const messages = readdirSync(inbox).filter((name) => name.endsWith(".json") && !name.endsWith(".delivery.json"));
			expect(messages).toHaveLength(1);
			await expect(send.execute("call", { target: grandchild.nodeId, kind: "instruction", body: "bypass" })).rejects.toThrow("direct parent");
			const inbound = { schemaVersion: 1, messageId: "msg_inbound", runId: index.runId, fromNodeId: child.nodeId, toNodeId: index.nodeId, kind: "instruction", body: "parent instruction", createdAt: Date.now() };
			const rootInbox = join(runPath, "inbox", index.nodeId);
			mkdirSync(rootInbox, { recursive: true });
			writeFileSync(join(rootInbox, "msg_inbound.json"), `${JSON.stringify(inbound)}\n`);
			writeFileSync(join(rootInbox, "msg_inbound.delivery.json"), `${JSON.stringify({ schemaVersion: 1, messageId: "msg_inbound", state: "pending", claimedAt: null, claimedBy: null, ackedAt: null })}\n`);
			const receivedMessage = () => harness.messages.some((message) => message.customType === "agent-swarm-inbox" && message.details.messageId === "msg_inbound");
			const deadline = Date.now() + 200;
			while (!receivedMessage() && Date.now() < deadline) await Bun.sleep(5);
			expect(receivedMessage()).toBe(true);

			child.status = "awaiting-review";
			child.result = { text: "result", submittedAt: Date.now() };
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);
			await expect(harness.tools.get("swarm_review").execute("call", { target: child.nodeId, action: "accept" })).rejects.toThrow("descendants are active");
			await expect(harness.tools.get("swarm_review").execute("call", { target: child.nodeId, action: "reject" })).rejects.toThrow("descendants are active");
			expect(JSON.parse(readFileSync(join(runPath, "nodes", `${child.nodeId}.json`), "utf8")).status).toBe("awaiting-review");
			const review = await harness.tools.get("swarm_review").execute("call", { target: child.nodeId, action: "request-changes", feedback: "Please revise" });
			expect(review.content[0].text).toContain("rework");
			const updatedChild = JSON.parse(readFileSync(join(runPath, "nodes", `${child.nodeId}.json`), "utf8"));
			expect(updatedChild.status).toBe("rework");
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_CONFIG;
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("prevents a worker from completing while a descendant is active", async () => {
		const rootHarness = createHarness();
		let workerHarness: ReturnType<typeof createHarness> | undefined;
		try {
			await rootHarness.commands.get("swarm:start").handler("root", rootHarness.context);
			const index = JSON.parse(readFileSync(join(rootHarness.stateRoot, "sessions", "session-test.json"), "utf8"));
			const runPath = join(rootHarness.stateRoot, "runs", index.runId);
			const rootPath = join(runPath, "nodes", `${index.nodeId}.json`);
			const root = JSON.parse(readFileSync(rootPath, "utf8"));
			const child = { ...makeTreeNode("node_child", index.nodeId), runId: index.runId };
			const grandchild = { ...makeTreeNode("node_grandchild", child.nodeId), runId: index.runId };
			root.childIds = [child.nodeId];
			child.childIds = [grandchild.nodeId];
			writeFileSync(rootPath, `${JSON.stringify(root)}\n`);
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);
			writeFileSync(join(runPath, "nodes", `${grandchild.nodeId}.json`), `${JSON.stringify(grandchild)}\n`);

			workerHarness = createHarness(rootHarness.stateRoot, rootHarness.context.cwd, "worker-session");
			process.env.PI_SWARM_WORKER = "1";
			process.env.PI_SWARM_RUN_ID = index.runId;
			process.env.PI_SWARM_NODE_ID = child.nodeId;
			await workerHarness.lifecycle.get("session_start")?.({}, workerHarness.context);
			expect(workerHarness.activeTools()).not.toContain("swarm_set_objective");
			await expect(workerHarness.tools.get("swarm_set_objective").execute("call", { objective: "worker override" })).rejects.toThrow("Only the swarm root");
			await expect(workerHarness.tools.get("swarm_complete").execute("call", { result: "premature" })).rejects.toThrow("descendants are active");
			expect(JSON.parse(readFileSync(join(runPath, "nodes", `${child.nodeId}.json`), "utf8")).status).toBe("running");
		} finally {
			await rootHarness.lifecycle.get("session_shutdown")?.({}, rootHarness.context);
			await workerHarness?.lifecycle.get("session_shutdown")?.({}, workerHarness.context);
			for (const name of ["PI_SWARM_WORKER", "PI_SWARM_RUN_ID", "PI_SWARM_NODE_ID"]) delete process.env[name];
			rmSync(rootHarness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("opens /swarm:tree as a fullscreen two-pane navigator", async () => {
		const harness = createHarness();
		let view: any;
		let options: any;
		let closed = false;
		harness.context.hasUI = true;
		harness.context.mode = "tui";
		harness.context.ui.custom = async (factory: any, customOptions: any) => {
			options = customOptions;
			view = factory(treeTui(), treeTheme, {}, () => { closed = true; });
			return undefined;
		};
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			const index = JSON.parse(readFileSync(join(harness.stateRoot, "sessions", "session-test.json"), "utf8"));
			const runPath = join(harness.stateRoot, "runs", index.runId);
			const rootPath = join(runPath, "nodes", `${index.nodeId}.json`);
			const root = JSON.parse(readFileSync(rootPath, "utf8"));
			const child = { ...makeTreeNode("node_child", index.nodeId), runId: index.runId };
			root.childIds = [child.nodeId];
			writeFileSync(rootPath, `${JSON.stringify(root)}\n`);
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);

			await harness.commands.get("swarm:tree").handler("", harness.context);
			expect(options).toMatchObject({ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
			expect(view).toBeInstanceOf(SwarmTreeView);
			const initial = view.render(100).join("\n");
			expect(initial).toContain("└─");
			expect(initial).toContain("node_child");
			expect(view.getSelectedNodeId()).toBe(index.nodeId);
			for (const width of [1, 2, 3, 24, 100]) {
				expect(view.render(width).every((line: string) => line.length <= width)).toBe(true);
			}
			view.handleInput("j");
			expect(view.getSelectedNodeId()).toBe(child.nodeId);
			expect(view.render(100).join("\n")).toContain("Status: running");
			child.status = "awaiting-review";
			child.version++;
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);
			expect(view.render(100).join("\n")).toContain("awaiting-review");
			view.handleInput("q");
			expect(closed).toBe(true);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("toggles inactive agents with space and keeps selection visible", () => {
		const parent = makeTreeNode("node_parent", null);
		const active = makeTreeNode("node_active", parent.nodeId, "running");
		const completed = makeTreeNode("node_completed", parent.nodeId, "completed");
		parent.childIds = [active.nodeId, completed.nodeId];
		const view = new SwarmTreeView(treeTui(), treeTheme, { nodes: [parent, active, completed], rootId: parent.nodeId }, () => {});

		expect(view.getShowInactiveAgents()).toBe(false);
		expect(view.render(120).join("\n")).not.toContain(completed.nodeId);
		expect(view.render(240).join("\n")).toContain("space show inactive");

		view.handleInput(" ");
		expect(view.getShowInactiveAgents()).toBe(true);
		expect(view.render(120).join("\n")).toContain(completed.nodeId);
		expect(view.render(240).join("\n")).toContain("space hide inactive");

		view.handleInput("G");
		expect(view.getSelectedNodeId()).toBe(completed.nodeId);
		view.handleInput(" ");
		expect(view.getShowInactiveAgents()).toBe(false);
		expect(view.getSelectedNodeId()).toBe(parent.nodeId);
		expect(view.render(120).join("\n")).not.toContain(completed.nodeId);
	});

	test("shows activity timing, stale-worker warnings, and safe cleanup guidance", () => {
		const now = Date.now();
		const parent = makeTreeNode("node_parent", null);
		const child = makeTreeNode("node_child", parent.nodeId, "running");
		parent.childIds = [child.nodeId];
		child.createdAt = now - STALE_WORKER_THRESHOLD_MS - 60_000;
		child.updatedAt = now - STALE_WORKER_THRESHOLD_MS - 1_000;
		const view = new SwarmTreeView(treeTui(), treeTheme, { nodes: [parent, child], rootId: parent.nodeId }, () => {});
		expect(isStaleWorker(child, now)).toBe(true);
		expect(isStaleWorker({ ...child, status: "awaiting-review" }, now)).toBe(false);
		expect(formatDuration(65_000)).toBe("1m 05s");
		view.handleInput("j");
		const staleDetails = view.render(120).join("\n");
		expect(staleDetails).toContain("Last activity:");
		expect(staleDetails).toContain("Duration:");
		expect(staleDetails).toContain("Warning: worker may be stale");
		expect(staleDetails).toContain("swarm_observe node_child");
		expect(staleDetails).toContain("swarm_stop");
		expect(staleDetails).not.toContain("swarm_restart");

		child.updatedAt = now - STALE_WORKER_ESCALATE_MS - 1_000;
		expect(isEscalatedStaleWorker(child, now)).toBe(true);
		const escalatedDetails = view.render(120).join("\n");
		expect(escalatedDetails).toContain("Warning: worker is stale");
		expect(escalatedDetails).toContain("swarm_restart");

		child.status = "completed";
		child.updatedAt = now;
		child.version++;
		child.worktreePath = "/tmp/swarm-worktree";
		child.sharedDirectory = false;
		view.handleInput(" ");
		const cleanupDetails = view.render(120).join("\n");
		expect(cleanupDetails).toContain("Cleanup:");
		expect(cleanupDetails).toContain("swarm_cleanup node_child");
		expect(cleanupDetails).toContain("worktree must be clean");
	});

	test("renders and follows live tmux output for the selected node by default", () => {
		const parent = makeTreeNode("node_parent", null);
		const child = makeTreeNode("node_child", parent.nodeId);
		parent.childIds = [child.nodeId];
		child.tmuxSession = "pi-swarm-test";
		child.tmuxWindow = "w-child";
		let reads = 0;
		let latestLine = 29;
		const view = new SwarmTreeView(
			treeTui(),
			treeTheme,
			{ nodes: [parent, child], rootId: parent.nodeId },
			() => {},
			undefined,
			(node) => {
				reads++;
				expect(node.nodeId).toBe(child.nodeId);
				return `${Array.from({ length: latestLine + 1 }, (_, line) => `worker output ${line}`).join("\n")}\n\n\n`;
			},
		);
		view.handleInput("j");
		let rendered = view.render(120).join("\n");
		expect(reads).toBe(1);
		expect(view.getShowLiveOutput()).toBe(true);
		expect(rendered).toContain("Live output");
		expect(rendered).toContain("tmux: pi-swarm-test:w-child");
		expect(rendered).toContain("worker output 29");
		expect(rendered).not.toContain("worker output 0");
		expect(rendered).toContain("live auto-refresh");
		expect(rendered).toContain("o details");

		latestLine = 30;
		rendered = view.render(120).join("\n");
		expect(reads).toBe(2);
		expect(rendered).toContain("worker output 30");

		view.handleInput("[");
		rendered = view.render(120).join("\n");
		expect(rendered).toContain("worker output 18");
		expect(rendered).not.toContain("worker output 30");

		view.handleInput("o");
		rendered = view.render(120).join("\n");
		expect(view.getShowLiveOutput()).toBe(false);
		expect(rendered).toContain("Status: running");
		expect(rendered).toContain("Task:");
		expect(rendered).toContain("o live");
		expect(reads).toBe(3);

		view.handleInput("o");
		rendered = view.render(120).join("\n");
		expect(view.getShowLiveOutput()).toBe(true);
		expect(rendered).toContain("worker output 30");
		expect(reads).toBe(4);
	});

	test("builds connected rows for a worker's visible parent and children", () => {
		const parent = makeTreeNode("node_parent", null);
		const current = makeTreeNode("node_current", parent.nodeId);
		const child = makeTreeNode("node_child", current.nodeId);
		parent.childIds = [current.nodeId];
		current.childIds = [child.nodeId];
		const rows = buildTreeRows([current, parent, child], parent.nodeId);
		expect(rows.map((row: any) => row.node.nodeId)).toEqual([parent.nodeId, current.nodeId, child.nodeId]);
		expect(rows[1].prefix).toBe("└─ ");
		expect(rows[2].prefix).toBe("   └─ ");
	});

	test("wakes a parent once per active-child generation", async () => {
		const harness = createHarness();
		harness.context.isIdle = () => true;
		harness.context.hasPendingMessages = () => false;
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			const index = JSON.parse(readFileSync(join(harness.stateRoot, "sessions", "session-test.json"), "utf8"));
			const runPath = join(harness.stateRoot, "runs", index.runId);
			const rootPath = join(runPath, "nodes", `${index.nodeId}.json`);
			const root = JSON.parse(readFileSync(rootPath, "utf8"));
			const child = { ...makeTreeNode("node_child", index.nodeId), runId: index.runId };
			root.childIds = [child.nodeId];
			writeFileSync(rootPath, `${JSON.stringify(root)}\n`);
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);

			await harness.lifecycle.get("agent_end")?.(agentEndEvent("stop"), harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(0);
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(1);
			expect(harness.sentMessages[0]).toMatchObject({ options: { triggerTurn: true }, message: { customType: "agent-swarm-monitor", display: false } });
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(1);

			child.status = "awaiting-review";
			child.version++;
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);
			harness.events.get("tripp:agent-swarm-activity")?.({ kind: "state", source: "state", nodeId: child.nodeId });
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(2);

			child.status = "completed";
			child.version++;
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);
			harness.events.get("tripp:agent-swarm-activity")?.({ kind: "state", source: "state", nodeId: child.nodeId });
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(2);
			const secondChild = { ...makeTreeNode("node_second", index.nodeId), runId: index.runId };
			root.childIds = [secondChild.nodeId];
			writeFileSync(rootPath, `${JSON.stringify(root)}\n`);
			writeFileSync(join(runPath, "nodes", `${secondChild.nodeId}.json`), `${JSON.stringify(secondChild)}\n`);
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(3);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("does not double-wake for inbox delivery, pending work, or out-of-scope activity", async () => {
		const harness = createHarness();
		harness.context.isIdle = () => true;
		harness.context.hasPendingMessages = () => false;
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			const index = JSON.parse(readFileSync(join(harness.stateRoot, "sessions", "session-test.json"), "utf8"));
			const runPath = join(harness.stateRoot, "runs", index.runId);
			const rootPath = join(runPath, "nodes", `${index.nodeId}.json`);
			const root = JSON.parse(readFileSync(rootPath, "utf8"));
			const child = { ...makeTreeNode("node_child", index.nodeId), runId: index.runId };
			const grandchild = { ...makeTreeNode("node_grandchild", child.nodeId), runId: index.runId };
			root.childIds = [child.nodeId];
			child.childIds = [grandchild.nodeId];
			writeFileSync(rootPath, `${JSON.stringify(root)}\n`);
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);
			writeFileSync(join(runPath, "nodes", `${grandchild.nodeId}.json`), `${JSON.stringify(grandchild)}\n`);

			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(1);
			harness.events.get("tripp:agent-swarm-activity")?.({ kind: "result", source: "inbox", nodeId: index.nodeId });
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(1);
			harness.events.get("tripp:agent-swarm-activity")?.({ kind: "state", source: "state", nodeId: grandchild.nodeId });
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(1);

			harness.context.hasPendingMessages = () => true;
			child.version++;
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);
			harness.events.get("tripp:agent-swarm-activity")?.({ kind: "state", source: "state", nodeId: child.nodeId });
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(1);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("forces a same-generation manual monitor wake after a long successful summary", async () => {
		const timers = createTimerHarness();
		let timestamp = 2_000;
		const harness = createHarness(undefined, undefined, "session-test", {
			now: () => timestamp,
			scheduleTimer: timers.scheduleTimer,
		});
		try {
			await attachActiveChild(harness);
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			await harness.lifecycle.get("agent_end")?.(agentEndEvent("aborted"), harness.context);
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			const before = compactEvent("manual");
			timestamp = 9_000;
			await harness.lifecycle.get("session_before_compact")?.(before, harness.context);
			// Eligibility is associated before summarization, not at completion.
			timestamp = 100_000;
			await harness.lifecycle.get("session_compact")?.(before, harness.context);

			expect(timers.pending()).toHaveLength(1);
			expect(timers.pending()[0].delayMs).toBe(0);
			timers.run();
			const monitors = harness.messages.filter((message) => message.customType === "agent-swarm-monitor");
			expect(monitors).toHaveLength(2);
			expect(monitors[0].details.generation).toBe(monitors[1].details.generation);
			expect(monitors[1].details.recovery).toBe("compaction");
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("keeps a pre-settlement interruption associated after slow agent_end handlers", async () => {
		const timers = createTimerHarness();
		let timestamp = 1_000;
		const harness = createHarness(undefined, undefined, "session-test", {
			now: () => timestamp,
			scheduleTimer: timers.scheduleTimer,
		});
		try {
			await attachActiveChild(harness);
			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			await harness.lifecycle.get("agent_end")?.(agentEndEvent("aborted"), harness.context);
			timestamp = 20_000;
			const event = compactEvent("manual");
			await harness.lifecycle.get("session_before_compact")?.(event, harness.context);
			await harness.lifecycle.get("session_compact")?.(event, harness.context);
			timers.run();

			const recoveries = harness.messages.filter((message) => message.customType === "agent-swarm-monitor" && message.details.recovery === "compaction");
			expect(recoveries).toHaveLength(1);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("does not associate a stale post-settlement interruption", async () => {
		const timers = createTimerHarness();
		let timestamp = 1_000;
		let idle = false;
		const harness = createHarness(undefined, undefined, "session-test", {
			now: () => timestamp,
			scheduleTimer: timers.scheduleTimer,
		});
		try {
			await attachActiveChild(harness);
			harness.context.isIdle = () => idle;
			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			await harness.lifecycle.get("agent_end")?.(agentEndEvent("aborted"), harness.context);
			timestamp = 1_500;
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			timestamp = 12_000;
			idle = true;
			const event = compactEvent("manual");
			await harness.lifecycle.get("session_before_compact")?.(event, harness.context);
			await harness.lifecycle.get("session_compact")?.(event, harness.context);
			timers.run();

			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toEqual([]);
			expect(timers.pending()).toEqual([]);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test.each(["error", "length"] as const)(
		"recovers threshold compaction after an incomplete %s run",
		async (stopReason) => {
			const timers = createTimerHarness();
			const harness = createHarness(undefined, undefined, "session-test", { scheduleTimer: timers.scheduleTimer });
			try {
				await attachActiveChild(harness);
				await harness.lifecycle.get("agent_settled")?.({}, harness.context);
				await harness.lifecycle.get("agent_start")?.({}, harness.context);
				await harness.lifecycle.get("agent_end")?.(agentEndEvent(stopReason), harness.context);
				await harness.lifecycle.get("agent_settled")?.({}, harness.context);
				const event = compactEvent("threshold");
				await harness.lifecycle.get("session_before_compact")?.(event, harness.context);
				await harness.lifecycle.get("session_compact")?.(event, harness.context);
				timers.run();

				const recoveries = harness.messages.filter((message) => message.customType === "agent-swarm-monitor" && message.details.recovery === "compaction");
				expect(recoveries).toHaveLength(1);
			} finally {
				await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
				rmSync(harness.stateRoot, { recursive: true, force: true });
				delete process.env.PI_SWARM_HOME;
			}
		},
	);

	test("does not duplicate a monitor already queued after the interrupted run", async () => {
		const timers = createTimerHarness();
		const harness = createHarness(undefined, undefined, "session-test", { scheduleTimer: timers.scheduleTimer });
		try {
			await attachActiveChild(harness);
			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			await harness.lifecycle.get("agent_end")?.(agentEndEvent("aborted"), harness.context);
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			const event = compactEvent("manual");
			await harness.lifecycle.get("session_before_compact")?.(event, harness.context);
			await harness.lifecycle.get("session_compact")?.(event, harness.context);
			timers.run();

			const monitors = harness.messages.filter((message) => message.customType === "agent-swarm-monitor");
			expect(monitors).toHaveLength(1);
			expect(monitors[0].details.recovery).toBeUndefined();
			expect(timers.pending()).toEqual([]);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test.each([
		["completed run", "stop", "manual", false],
		["overflow compaction", "error", "overflow", false],
		["compaction retry", "aborted", "manual", true],
	] as const)("does not force monitoring after a %s", async (_name, stopReason, reason, willRetry) => {
		const timers = createTimerHarness();
		const harness = createHarness(undefined, undefined, "session-test", { scheduleTimer: timers.scheduleTimer });
		try {
			await attachActiveChild(harness);
			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			await harness.lifecycle.get("agent_end")?.(agentEndEvent(stopReason), harness.context);
			const event = compactEvent(reason, willRetry);
			await harness.lifecycle.get("session_before_compact")?.(event, harness.context);
			await harness.lifecycle.get("session_compact")?.(event, harness.context);
			timers.run();

			expect(timers.pending()).toEqual([]);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toEqual([]);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("deduplicates repeated compaction success events", async () => {
		const timers = createTimerHarness();
		const harness = createHarness(undefined, undefined, "session-test", { scheduleTimer: timers.scheduleTimer });
		try {
			await attachActiveChild(harness);
			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			await harness.lifecycle.get("agent_end")?.(agentEndEvent("aborted"), harness.context);
			const event = compactEvent("manual");
			await harness.lifecycle.get("session_before_compact")?.(event, harness.context);
			await harness.lifecycle.get("session_compact")?.(event, harness.context);
			await harness.lifecycle.get("session_compact")?.(event, harness.context);

			expect(timers.pending()).toHaveLength(1);
			timers.run();
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(1);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("cancels compaction recovery when another owner starts an agent run", async () => {
		const timers = createTimerHarness();
		const harness = createHarness(undefined, undefined, "session-test", { scheduleTimer: timers.scheduleTimer });
		try {
			await attachActiveChild(harness);
			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			await harness.lifecycle.get("agent_end")?.(agentEndEvent("aborted"), harness.context);
			const event = compactEvent("manual");
			await harness.lifecycle.get("session_before_compact")?.(event, harness.context);
			await harness.lifecycle.get("session_compact")?.(event, harness.context);
			expect(timers.pending()).toHaveLength(1);

			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			timers.run(true);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toEqual([]);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("does not recover monitoring when the current owner has no active children", async () => {
		const timers = createTimerHarness();
		const harness = createHarness(undefined, undefined, "session-test", { scheduleTimer: timers.scheduleTimer });
		harness.context.isIdle = () => true;
		harness.context.hasPendingMessages = () => false;
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			await harness.lifecycle.get("agent_end")?.(agentEndEvent("aborted"), harness.context);
			const event = compactEvent("manual");
			await harness.lifecycle.get("session_before_compact")?.(event, harness.context);
			await harness.lifecycle.get("session_compact")?.(event, harness.context);
			timers.run();

			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toEqual([]);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("cancels compaction recovery on shutdown", async () => {
		const timers = createTimerHarness();
		const harness = createHarness(undefined, undefined, "session-test", { scheduleTimer: timers.scheduleTimer });
		try {
			await attachActiveChild(harness);
			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			await harness.lifecycle.get("agent_end")?.(agentEndEvent("aborted"), harness.context);
			const event = compactEvent("manual");
			await harness.lifecycle.get("session_before_compact")?.(event, harness.context);
			await harness.lifecycle.get("session_compact")?.(event, harness.context);
			expect(timers.pending()).toHaveLength(1);

			await harness.lifecycle.get("session_shutdown")?.({ reason: "reload" }, harness.context);
			timers.run(true);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toEqual([]);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	test("keeps the settled monitor path as fallback when the forced wake cannot send", async () => {
		const timers = createTimerHarness();
		const harness = createHarness(undefined, undefined, "session-test", { scheduleTimer: timers.scheduleTimer });
		let idle = true;
		try {
			await attachActiveChild(harness);
			harness.context.isIdle = () => idle;
			await harness.lifecycle.get("agent_start")?.({}, harness.context);
			await harness.lifecycle.get("agent_end")?.(agentEndEvent("aborted"), harness.context);
			const event = compactEvent("manual");
			await harness.lifecycle.get("session_before_compact")?.(event, harness.context);
			await harness.lifecycle.get("session_compact")?.(event, harness.context);
			idle = false;
			timers.run();
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toEqual([]);

			idle = true;
			await harness.lifecycle.get("agent_settled")?.({}, harness.context);
			expect(harness.messages.filter((message) => message.customType === "agent-swarm-monitor")).toHaveLength(1);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	const tmuxTest = spawnSync("tmux", ["-V"]).status === 0 ? test : test.skip;
	const realPiTest = spawnSync(process.env.PI_BIN ?? "pi", ["--version"]).status === 0 && spawnSync("tmux", ["-V"]).status === 0 ? test : test.skip;
	realPiTest("propagates root trust so a real worker bypasses the generated-worktree prompt", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pi-agent-swarm-trust-"));
		const state = mkdtempSync(join(tmpdir(), "pi-agent-swarm-trust-state-"));
		const previousPi = process.env.PI_BIN;
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_BIN = previousPi ?? "pi";
		process.env.PI_OFFLINE = "1";
		git(repo, "init", "-q");
		git(repo, "config", "user.name", "Pi Test");
		git(repo, "config", "user.email", "pi-test@example.invalid");
		mkdirSync(join(repo, ".pi"), { recursive: true });
		writeFileSync(join(repo, ".pi", "settings.json"), "{}\n");
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		git(repo, "add", ".pi/settings.json", "tracked.txt");
		git(repo, "commit", "-qm", "initial");
		git(repo, "branch", "-M", "main");
		const harness = createHarness(state, repo);
		harness.context.model = null;
		harness.context.thinkingLevel = "off";
		harness.context.isProjectTrusted = () => true;
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			const spawned = await harness.tools.get("swarm_spawn").execute("call", { task: "trust smoke" }, undefined, undefined, harness.context);
			expect(["ready", "running"]).toContain(spawned.details.node.status);
			const launchOutput = spawnSync("tmux", ["capture-pane", "-p", "-J", "-t", `${spawned.details.node.tmuxSession}:${spawned.details.node.tmuxWindow}`, "-S", "-80"], { encoding: "utf8" }).stdout;
			expect(launchOutput).not.toContain("Trust project folder?");
			await harness.tools.get("swarm_stop").execute("call", { target: spawned.details.node.nodeId });
			await harness.tools.get("swarm_cleanup").execute("call", { target: spawned.details.node.nodeId });
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			if (previousPi === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = previousPi;
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			delete process.env.PI_SWARM_HOME;
			rmSync(repo, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	}, 40_000);

	tmuxTest("creates a child worktree and transfers dirty changes without mutating the parent", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pi-agent-swarm-repo-"));
		const state = mkdtempSync(join(tmpdir(), "pi-agent-swarm-state-"));
		const worker = createReadyWorker(state);
		const previousPi = process.env.PI_BIN;
		process.env.PI_BIN = worker;
		git(repo, "init", "-q");
		git(repo, "config", "user.name", "Pi Test");
		git(repo, "config", "user.email", "pi-test@example.invalid");
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		git(repo, "add", "tracked.txt");
		git(repo, "commit", "-qm", "initial");
		git(repo, "branch", "-M", "main");
		writeFileSync(join(repo, "tracked.txt"), "dirty\n");
		const harness = createHarness(state, repo);
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			harness.sessionEntries.push({ type: "custom", customType: "codex-fast-mode-state", data: { enabled: true } });
			const spawn = harness.tools.get("swarm_spawn");
			await expect(spawn.execute("call", { task: "work" }, undefined, undefined, harness.context)).rejects.toThrow("dirtyMode");
			await expect(spawn.execute("call", { task: "work", dirtyMode: "commit-parent" }, undefined, undefined, harness.context)).rejects.toThrow("protected branch");
			const result = await spawn.execute("call", { task: "work", dirtyMode: "commit-child" }, undefined, undefined, harness.context);
			const child = result.details.node;
			expect(child.status).toBe("ready");
			expect(child.worktreePath).toBeTruthy();
			const launch = JSON.parse(readFileSync(join(state, `${child.nodeId}.launch.json`), "utf8"));
			const extensionPaths = launch.args.flatMap((arg: string, index: number, args: string[]) => arg === "--extension" ? [args[index + 1]] : []);
			expect(extensionPaths.some((path: string) => path.endsWith("/bg-bash/index.ts"))).toBe(true);
			expect(extensionPaths.some((path: string) => path.endsWith("/codex-fast-mode/index.ts"))).toBe(true);
			expect(launch.args).toContain("--approve");
			expect(launch.fastMode).toBe("on");
			expect(readFileSync(join(child.worktreePath, "tracked.txt"), "utf8")).toBe("dirty\n");
			expect(git(repo, "branch", "--show-current")).toBe("main");
			expect(git(repo, "status", "--porcelain")).toContain("tracked.txt");
			await harness.tools.get("swarm_stop").execute("call", { target: child.nodeId });
			await harness.tools.get("swarm_cleanup").execute("call", { target: child.nodeId });
			await expect(Bun.file(child.worktreePath).exists()).resolves.toBe(false);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			if (previousPi === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = previousPi;
			delete process.env.PI_SWARM_HOME;
			rmSync(repo, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	});

	tmuxTest("normalizes commit dirty modes when the parent repository is clean", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pi-agent-swarm-clean-modes-"));
		const state = mkdtempSync(join(tmpdir(), "pi-agent-swarm-clean-modes-state-"));
		const worker = createReadyWorker(state);
		const previousPi = process.env.PI_BIN;
		process.env.PI_BIN = worker;
		git(repo, "init", "-q");
		git(repo, "config", "user.name", "Pi Test");
		git(repo, "config", "user.email", "pi-test@example.invalid");
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		git(repo, "add", "tracked.txt");
		git(repo, "commit", "-qm", "initial");
		git(repo, "branch", "-M", "main");
		const harness = createHarness(state, repo);
		harness.context.isProjectTrusted = () => false;
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			for (const dirtyMode of ["commit-parent", "commit-child"] as const) {
				const spawned = await harness.tools.get("swarm_spawn").execute("call", { task: dirtyMode, dirtyMode }, undefined, undefined, harness.context);
				expect(spawned.details.worktreeMode).toBe("clean");
				const launch = JSON.parse(readFileSync(join(state, `${spawned.details.node.nodeId}.launch.json`), "utf8"));
				expect(launch.args).toContain("--no-approve");
				await harness.tools.get("swarm_stop").execute("call", { target: spawned.details.node.nodeId });
				await harness.tools.get("swarm_cleanup").execute("call", { target: spawned.details.node.nodeId });
			}
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			if (previousPi === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = previousPi;
			delete process.env.PI_SWARM_HOME;
			rmSync(repo, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	});

	test("kills workers and clears the root swarm setup", async () => {
		const harness = createHarness();
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			const index = JSON.parse(readFileSync(join(harness.stateRoot, "sessions", "session-test.json"), "utf8"));
			const runPath = join(harness.stateRoot, "runs", index.runId);
			const rootPath = join(runPath, "nodes", `${index.nodeId}.json`);
			const root = JSON.parse(readFileSync(rootPath, "utf8"));
			const child = { ...makeTreeNode("node_child", index.nodeId), runId: index.runId };
			root.childIds = [child.nodeId];
			writeFileSync(rootPath, `${JSON.stringify(root)}\n`);
			writeFileSync(join(runPath, "nodes", `${child.nodeId}.json`), `${JSON.stringify(child)}\n`);

			await harness.commands.get("swarm:kill").handler("", harness.context);
			expect(JSON.parse(readFileSync(join(runPath, "nodes", `${child.nodeId}.json`), "utf8")).status).toBe("stopped");
			expect(harness.notifications.at(-1)?.text).toContain("workers stopped: 1");

			await harness.commands.get("swarm:clear").handler("", harness.context);
			expect(await Bun.file(join(harness.stateRoot, "sessions", "session-test.json")).exists()).toBe(false);
			expect(await Bun.file(runPath).exists()).toBe(false);
			await expect(harness.tools.get("swarm_tree").execute("call", {}, undefined, undefined, harness.context)).rejects.toThrow("/swarm:start");
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			rmSync(harness.stateRoot, { recursive: true, force: true });
			delete process.env.PI_SWARM_HOME;
		}
	});

	const teardownTest = spawnSync("tmux", ["-V"]).status === 0 ? test : test.skip;
	teardownTest("refuses to clear a dirty worktree before killing workers", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pi-agent-swarm-clear-"));
		const state = mkdtempSync(join(tmpdir(), "pi-agent-swarm-clear-state-"));
		const worker = createReadyWorker(state);
		const previousPi = process.env.PI_BIN;
		process.env.PI_BIN = worker;
		git(repo, "init", "-q");
		git(repo, "config", "user.name", "Pi Test");
		git(repo, "config", "user.email", "pi-test@example.invalid");
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		git(repo, "add", "tracked.txt");
		git(repo, "commit", "-qm", "initial");
		git(repo, "branch", "-M", "main");
		const harness = createHarness(state, repo);
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			const spawned = await harness.tools.get("swarm_spawn").execute("call", { task: "keep dirty" }, undefined, undefined, harness.context);
			const child = spawned.details.node;
			writeFileSync(join(child.worktreePath, "tracked.txt"), "dirty-handoff\n");
			await expect(harness.tools.get("swarm_clear").execute("call", {}, undefined, undefined, harness.context)).rejects.toThrow("dirty");
			expect(JSON.parse(readFileSync(join(state, "runs", child.runId, "nodes", `${child.nodeId}.json`), "utf8")).status).toBe("ready");
			expect(await Bun.file(join(state, "sessions", "session-test.json")).exists()).toBe(true);
			expect(git(child.worktreePath, "status", "--porcelain")).toContain("tracked.txt");
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			if (previousPi === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = previousPi;
			delete process.env.PI_SWARM_HOME;
			rmSync(repo, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	});

	teardownTest("cleans every eligible terminal worktree when swarm_cleanup has no target", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pi-agent-swarm-cleanup-"));
		const state = mkdtempSync(join(tmpdir(), "pi-agent-swarm-cleanup-state-"));
		const worker = createReadyWorker(state);
		const previousPi = process.env.PI_BIN;
		process.env.PI_BIN = worker;
		git(repo, "init", "-q");
		git(repo, "config", "user.name", "Pi Test");
		git(repo, "config", "user.email", "pi-test@example.invalid");
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		git(repo, "add", "tracked.txt");
		git(repo, "commit", "-qm", "initial");
		git(repo, "branch", "-M", "main");
		const harness = createHarness(state, repo);
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			const first = await harness.tools.get("swarm_spawn").execute("call", { task: "clean me" }, undefined, undefined, harness.context);
			const second = await harness.tools.get("swarm_spawn").execute("call", { task: "keep running" }, undefined, undefined, harness.context);
			const cleanNode = first.details.node;
			const liveNode = second.details.node;
			await harness.tools.get("swarm_stop").execute("call", { target: cleanNode.nodeId });
			const cleaned = await harness.tools.get("swarm_cleanup").execute("call", {}, undefined, undefined, harness.context);
			expect(cleaned.content[0].text).toContain(cleanNode.nodeId);
			expect(cleaned.content[0].text).not.toContain(liveNode.nodeId);
			expect(JSON.parse(readFileSync(join(state, "runs", cleanNode.runId, "nodes", `${cleanNode.nodeId}.json`), "utf8")).cleanedAt).toBeTruthy();
			expect(await Bun.file(cleanNode.worktreePath).exists()).toBe(false);
			const liveAfter = JSON.parse(readFileSync(join(state, "runs", liveNode.runId, "nodes", `${liveNode.nodeId}.json`), "utf8"));
			expect(liveAfter.status).toBe("ready");
			expect(liveAfter.cleanedAt).toBeNull();
			expect(existsSync(liveAfter.worktreePath)).toBe(true);
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			if (previousPi === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = previousPi;
			delete process.env.PI_SWARM_HOME;
			rmSync(repo, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	});

	const restartTest = spawnSync("tmux", ["-V"]).status === 0 ? test : test.skip;
	restartTest("restarts failed and stopped workers in place and refuses completed ones", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pi-agent-swarm-restart-"));
		const state = mkdtempSync(join(tmpdir(), "pi-agent-swarm-restart-state-"));
		const worker = createReadyWorker(state);
		const previousPi = process.env.PI_BIN;
		process.env.PI_BIN = worker;
		git(repo, "init", "-q");
		git(repo, "config", "user.name", "Pi Test");
		git(repo, "config", "user.email", "pi-test@example.invalid");
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		git(repo, "add", "tracked.txt");
		git(repo, "commit", "-qm", "initial");
		git(repo, "branch", "-M", "main");
		const harness = createHarness(state, repo);
		try {
			await harness.commands.get("swarm:start").handler("root", harness.context);
			const spawn = await harness.tools.get("swarm_spawn").execute("call", { task: "keep going" }, undefined, undefined, harness.context);
			const child = spawn.details.node;
			const nodePath = join(state, "runs", child.runId, "nodes", `${child.nodeId}.json`);
			const inbox = join(state, "runs", child.runId, "inbox", child.nodeId);
			mkdirSync(inbox, { recursive: true });
			writeFileSync(join(inbox, "msg_keep.json"), `${JSON.stringify({ schemaVersion: 1, messageId: "msg_keep", runId: child.runId, fromNodeId: "node_root", toNodeId: child.nodeId, kind: "message", body: "keep", createdAt: Date.now() })}\n`);
			await harness.tools.get("swarm_stop").execute("call", { target: child.nodeId });
			expect(JSON.parse(readFileSync(nodePath, "utf8")).status).toBe("stopped");

			const restarted = await harness.tools.get("swarm_restart").execute("call", { target: child.nodeId }, undefined, undefined, harness.context);
			expect(restarted.details.node.nodeId).toBe(child.nodeId);
			expect(restarted.details.node.status).toBe("ready");
			expect(restarted.details.node.worktreePath).toBe(child.worktreePath);
			expect(restarted.details.node.branch).toBe(child.branch);
			expect(await Bun.file(join(inbox, "msg_keep.json")).exists()).toBe(true);
			const launch = JSON.parse(readFileSync(join(state, `${child.nodeId}.launch.json`), "utf8"));
			expect(launch.args).toContain(`swarm-${child.nodeId}`);

			const completed = JSON.parse(readFileSync(nodePath, "utf8"));
			completed.status = "completed";
			writeFileSync(nodePath, `${JSON.stringify(completed)}\n`);
			await expect(harness.tools.get("swarm_restart").execute("call", { target: child.nodeId }, undefined, undefined, harness.context)).rejects.toThrow("completed");
		} finally {
			await harness.lifecycle.get("session_shutdown")?.({}, harness.context);
			if (previousPi === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = previousPi;
			delete process.env.PI_SWARM_HOME;
			rmSync(repo, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	});

	restartTest("reconnects a resumed root session and relaunches its dead running workers", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pi-agent-swarm-reconnect-"));
		const state = mkdtempSync(join(tmpdir(), "pi-agent-swarm-reconnect-state-"));
		const worker = createReadyWorker(state);
		const previousPi = process.env.PI_BIN;
		process.env.PI_BIN = worker;
		git(repo, "init", "-q");
		git(repo, "config", "user.name", "Pi Test");
		git(repo, "config", "user.email", "pi-test@example.invalid");
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		git(repo, "add", "tracked.txt");
		git(repo, "commit", "-qm", "initial");
		git(repo, "branch", "-M", "main");
		const first = createHarness(state, repo);
		let second: ReturnType<typeof createHarness> | undefined;
		try {
			await first.commands.get("swarm:start").handler("root", first.context);
			const spawned = await first.tools.get("swarm_spawn").execute("call", { task: "survive root resume" }, undefined, undefined, first.context);
			const child = spawned.details.node;
			await first.tools.get("swarm_stop").execute("call", { target: child.nodeId });
			const childPath = join(state, "runs", child.runId, "nodes", `${child.nodeId}.json`);
			const disconnected = JSON.parse(readFileSync(childPath, "utf8"));
			disconnected.status = "running";
			disconnected.failure = null;
			writeFileSync(childPath, `${JSON.stringify(disconnected)}\n`);
			await first.lifecycle.get("session_shutdown")?.({}, first.context);

			second = createHarness(state, repo);
			await second.lifecycle.get("session_start")?.({}, second.context);
			expect(JSON.parse(readFileSync(childPath, "utf8")).status).toBe("ready");
			expect(second.emissions.some((emission) => emission.value.kind === "repair" && emission.value.childIds.includes(child.nodeId))).toBe(true);
		} finally {
			await first.lifecycle.get("session_shutdown")?.({}, first.context);
			await second?.lifecycle.get("session_shutdown")?.({}, second.context);
			if (previousPi === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = previousPi;
			delete process.env.PI_SWARM_HOME;
			rmSync(repo, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	});

	restartTest("resumes by relaunching a dead running worker and leaving failed workers stopped", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pi-agent-swarm-repair-"));
		const state = mkdtempSync(join(tmpdir(), "pi-agent-swarm-repair-state-"));
		const worker = createReadyWorker(state);
		const previousPi = process.env.PI_BIN;
		process.env.PI_BIN = worker;
		git(repo, "init", "-q");
		git(repo, "config", "user.name", "Pi Test");
		git(repo, "config", "user.email", "pi-test@example.invalid");
		writeFileSync(join(repo, "tracked.txt"), "base\n");
		git(repo, "add", "tracked.txt");
		git(repo, "commit", "-qm", "initial");
		git(repo, "branch", "-M", "main");
		const first = createHarness(state, repo);
		let second: ReturnType<typeof createHarness> | undefined;
		try {
			await first.commands.get("swarm:start").handler("root", first.context);
			const live = await first.tools.get("swarm_spawn").execute("call", { task: "stay running" }, undefined, undefined, first.context);
			const failed = await first.tools.get("swarm_spawn").execute("call", { task: "stay failed" }, undefined, undefined, first.context);
			const liveNode = live.details.node;
			const failedNode = failed.details.node;
			await first.tools.get("swarm_stop").execute("call", { target: liveNode.nodeId });
			const livePath = join(state, "runs", liveNode.runId, "nodes", `${liveNode.nodeId}.json`);
			const failedPath = join(state, "runs", failedNode.runId, "nodes", `${failedNode.nodeId}.json`);
			const restored = JSON.parse(readFileSync(livePath, "utf8"));
			restored.status = "running";
			restored.failure = null;
			writeFileSync(livePath, `${JSON.stringify(restored)}\n`);
			const markedFailed = JSON.parse(readFileSync(failedPath, "utf8"));
			markedFailed.status = "failed";
			markedFailed.failure = "boom";
			writeFileSync(failedPath, `${JSON.stringify(markedFailed)}\n`);
			const index = JSON.parse(readFileSync(join(state, "sessions", "session-test.json"), "utf8"));
			await first.commands.get("swarm:pause").handler("", first.context);
			await first.lifecycle.get("session_shutdown")?.({}, first.context);

			second = createHarness(state, repo, "session-resumed");
			await second.lifecycle.get("session_start")?.({}, second.context);
			await second.commands.get("swarm:resume").handler(index.runId, second.context);
			expect(JSON.parse(readFileSync(livePath, "utf8")).status).toBe("ready");
			expect(JSON.parse(readFileSync(failedPath, "utf8")).status).toBe("failed");
			expect(second.emissions.some((emission) => emission.value.kind === "repair" && emission.value.childIds.includes(liveNode.nodeId))).toBe(true);
		} finally {
			await first.lifecycle.get("session_shutdown")?.({}, first.context);
			await second?.lifecycle.get("session_shutdown")?.({}, second.context);
			if (previousPi === undefined) delete process.env.PI_BIN;
			else process.env.PI_BIN = previousPi;
			delete process.env.PI_SWARM_HOME;
			rmSync(repo, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		}
	});
});
