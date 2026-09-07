import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

interface BtwSlot {
	question: string;
	thinking: string;
	answer: string;
	done: boolean;
	activity?: string[];
}

function formatActivity(activity: string[]): string {
	const counts = new Map<string, number>();
	for (const item of activity) counts.set(item, (counts.get(item) ?? 0) + 1);
	const summary = [...counts.entries()]
		.slice(0, 6)
		.map(([name, count]) => (count === 1 ? name : `${name}×${count}`));
	if (counts.size > summary.length) summary.push(`+${counts.size - summary.length} more`);
	return `used ${summary.join(", ")}`;
}

function formatBtw(slot: BtwSlot, theme: any): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const green = (s: string) => theme.fg("success", s);
	const italic = (s: string) => theme.fg("dim", theme.italic(s));
	const yellow = (s: string) => theme.fg("warning", s);
	const lines = [dim("💭 btw ") + green("› ") + slot.question];

	if (slot.activity?.length) lines.push(italic(formatActivity(slot.activity)));

	if (slot.thinking && !slot.answer) {
		lines.push(italic(slot.thinking) + (slot.done ? "" : yellow(" ▍")));
	}

	if (slot.answer) {
		lines.push(slot.answer + (slot.done ? "" : yellow(" ▍")));
	} else if (!slot.thinking) {
		lines.push(yellow("⏳ thinking..."));
	}

	return lines;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function buildSideQuestion(question: string, allowTools: boolean): string {
	return [
		"Answer this as a /btw side question while preserving the main session as context.",
		allowTools
			? "Use tools when they help answer the side question. Inspect freely, but modify files only if this side question explicitly asks you to make changes."
			: "Do not call tools for this side question; answer directly from the existing context.",
		"Afterward, provide a concise final answer for the side conversation.",
		"",
		question,
	].join("\n");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function copySessionToTemp(sessionFile: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-btw-session-"));
	const filePath = path.join(dir, path.basename(sessionFile));
	await fs.promises.copyFile(sessionFile, filePath);
	return { dir, filePath };
}

function removeTempSession(temp: { dir: string; filePath: string } | undefined) {
	if (!temp) return;
	try {
		fs.unlinkSync(temp.filePath);
	} catch {
		/* ignore */
	}
	try {
		fs.rmdirSync(temp.dir);
	} catch {
		/* ignore */
	}
}

/**
 * /btw [question] — Answer inline using a temp copy of the current session.
 * /btw:tools [question] — Same display, but allows tool calls in the temp session.
 */
export default function (pi: ExtensionAPI) {
	const runningAgents = new Set<ChildProcess>();

	pi.registerMessageRenderer("btw", (message, _options, theme) => {
		const details = message.details as BtwSlot | undefined;
		const slot = details ?? { question: "", thinking: "", answer: message.content.toString(), done: true };
		const parts = formatBtw(slot, theme);
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(parts.join("\n"), 0, 0));
		return box;
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => {
			const customMessage = message as { customType?: string };
			return customMessage.customType !== "btw";
		}),
	}));

	pi.on("tool_call", async () => {
		if (process.env.PI_BTW_BLOCK_TOOLS === "1") {
			return { block: true, reason: "/btw side answers run without tools" };
		}
	});

	pi.on("session_shutdown", async () => {
		for (const proc of runningAgents) proc.kill("SIGTERM");
		runningAgents.clear();
	});

	function showBtw(slot: BtwSlot) {
		pi.sendMessage({
			customType: "btw",
			content: slot.answer || slot.thinking || "thinking...",
			display: true,
			details: { ...slot },
		});
	}

	function askBtw(ctx: ExtensionContext, question: string, allowTools: boolean) {
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			ctx.ui.notify("/btw requires a saved session so it can reuse the current prefix", "error");
			return;
		}

		const slot: BtwSlot = { question, thinking: "", answer: "", done: false, activity: allowTools ? [] : undefined };

		(async () => {
			let tempSession: { dir: string; filePath: string } | undefined;
			try {
				tempSession = await copySessionToTemp(sessionFile);
				const thinkingLevel = pi.getThinkingLevel();
				const modelArg = `${model.provider}/${model.id}${thinkingLevel === "off" ? "" : `:${thinkingLevel}`}`;
				const args = ["--mode", "json", "-p", "--session", tempSession.filePath, "--model", modelArg];

				// Code's outer tool projection is not a child-session allowlist.
				args.push(buildSideQuestion(question, allowTools));

				const invocation = getPiInvocation(args);
				const proc = spawn(invocation.command, invocation.args, {
					cwd: ctx.cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, PI_BTW_BLOCK_TOOLS: allowTools ? "" : "1" },
				});
				runningAgents.add(proc);

				let stdoutBuffer = "";
				let stderr = "";

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}

					if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
						slot.thinking += event.assistantMessageEvent.delta;
						return;
					}

					if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
						slot.activity?.push(event.toolName);
						return;
					}

					if (event.type === "message_end" && event.message?.role === "assistant") {
						const text = textFromContent(event.message.content).trim();
						if (text) slot.answer = text;
						if (event.message.errorMessage) slot.answer = `❌ ${event.message.errorMessage}`;
					}
				};

				proc.stdout?.on("data", (data) => {
					stdoutBuffer += data.toString();
					const lines = stdoutBuffer.split("\n");
					stdoutBuffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				});

				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});

				const exitCode = await new Promise<number>((resolve) => {
					proc.on("close", (code) => {
						if (stdoutBuffer.trim()) processLine(stdoutBuffer);
						resolve(code ?? 0);
					});
					proc.on("error", () => resolve(1));
				});

				runningAgents.delete(proc);
				slot.done = true;
				if (exitCode !== 0 && !slot.answer) {
					slot.answer = `❌ btw exited with code ${exitCode}${stderr.trim() ? `\n${stderr.trim()}` : ""}`;
				} else if (!slot.answer) {
					slot.answer = stderr.trim() ? `❌ ${stderr.trim()}` : "(no answer)";
				}
				showBtw(slot);
			} catch (err: any) {
				slot.answer = `❌ ${err.message}`;
				slot.done = true;
				showBtw(slot);
			} finally {
				removeTempSession(tempSession);
			}
		})();
	}

	pi.registerCommand("btw", {
		description: "Answer a side question using the current session prefix without tools",
		handler: async (args, ctx) => {
			const question = args.trim();

			if (question) {
				askBtw(ctx, question, false);
			} else {
				ctx.ui.notify("Usage: /btw <question>", "info");
			}
		},
	});

	pi.registerCommand("btw:tools", {
		description: "Answer a side question using the current session prefix with active tools enabled",
		handler: async (args, ctx) => {
			const question = args.trim();

			if (question) {
				askBtw(ctx, question, true);
			} else {
				ctx.ui.notify("Usage: /btw:tools <question>", "info");
			}
		},
	});
}
