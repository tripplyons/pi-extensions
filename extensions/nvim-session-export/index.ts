import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentMessage, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";

type TextPart = { type: "text"; text: string };
type ThinkingPart = { type: "thinking"; thinking: string };
type ToolCallPart = { type: "toolCall"; id: string; name: string; arguments: unknown };
type MessagePart = TextPart | ThinkingPart | ToolCallPart | Record<string, unknown>;

type ExportOptions = {
	openInNvim: boolean;
	outputPath?: string;
};

function expandPath(value: string, cwd: string): string {
	const expanded = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function defaultExportPath(ctx: ExtensionContext): string {
	const sessionId = ctx.sessionManager.getSessionId();
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(homedir(), ".pi", "agent", "exports", `${sessionId}-${timestamp}.md`);
}

function parseArgs(args: string, ctx: ExtensionContext): ExportOptions {
	const trimmed = args.trim();
	if (!trimmed) return { openInNvim: true };

	const parts = trimmed.split(/\s+/);
	let openInNvim = true;
	const pathParts: string[] = [];

	for (const part of parts) {
		if (part === "--no-open") openInNvim = false;
		else if (part === "--open") openInNvim = true;
		else pathParts.push(part);
	}

	return {
		openInNvim,
		outputPath: pathParts.length > 0 ? expandPath(pathParts.join(" "), ctx.cwd) : undefined,
	};
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part): string[] => {
			const item = part as { type?: string; text?: string };
			return item.type === "text" && item.text ? [item.text] : [];
		})
		.join("\n");
}

function fence(value: unknown, language = "json"): string {
	const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	const ticks = body.includes("```") ? "````" : "```";
	return `${ticks}${language}\n${body}\n${ticks}`;
}

function renderUser(message: AgentMessage): string {
	return `## User\n\n${textFromContent((message as { content?: unknown }).content).trim()}\n`;
}

function renderAssistant(message: AgentMessage): string {
	const content = (message as { content?: MessagePart[] }).content ?? [];
	const sections: string[] = [];

	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			sections.push(part.text.trim());
		} else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
			sections.push(`<details>\n<summary>Thinking</summary>\n\n${part.thinking.trim()}\n\n</details>`);
		} else if (part.type === "toolCall") {
			sections.push(`### Tool call: ${part.name}\n\n${fence(part.arguments)}`);
		}
	}

	return `## Assistant\n\n${sections.join("\n\n").trim()}\n`;
}

function renderToolResult(message: AgentMessage): string {
	const toolName = (message as { toolName?: string; name?: string }).toolName ?? (message as { name?: string }).name ?? "tool";
	const content = textFromContent((message as { content?: unknown }).content);
	const isError = (message as { isError?: boolean }).isError;
	return `## Tool result: ${toolName}${isError ? " (error)" : ""}\n\n${content.trim()}\n`;
}

function renderOther(message: AgentMessage): string {
	const role = (message as { role?: string }).role ?? "message";
	if (role === "custom") {
		const customType = (message as { customType?: string }).customType ?? "custom";
		return `## ${customType}\n\n${textFromContent((message as { content?: unknown }).content).trim()}\n`;
	}
	return `## ${role}\n\n${fence(message)}\n`;
}

function renderMessage(message: AgentMessage): string {
	switch ((message as { role?: string }).role) {
		case "user":
			return renderUser(message);
		case "assistant":
			return renderAssistant(message);
		case "toolResult":
			return renderToolResult(message);
		default:
			return renderOther(message);
	}
}

function renderSessionMarkdown(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch() as SessionEntry[];
	const context = buildSessionContext(entries, ctx.sessionManager.getLeafId());
	const header = [
		"# Pi Session Export",
		"",
		`- Session: ${ctx.sessionManager.getSessionId()}`,
		`- CWD: ${ctx.cwd}`,
		`- Exported: ${new Date().toISOString()}`,
		"",
	].join("\n");

	return `${header}${context.messages.map(renderMessage).join("\n---\n\n").trim()}\n`;
}

function writeExport(ctx: ExtensionContext, outputPath: string): void {
	mkdirSync(path.dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, renderSessionMarkdown(ctx), "utf8");
}

function setRawMode(enabled: boolean): void {
	if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
		process.stdin.setRawMode(enabled);
	}
}

function openInNvim(file: string, cwd: string): boolean {
	setRawMode(false);
	try {
		const result = spawnSync("nvim", [file], { cwd, stdio: "inherit" });
		return result.status === 0;
	} finally {
		setRawMode(true);
	}
}

async function exportSession(args: string, ctx: ExtensionContext): Promise<void> {
	const options = parseArgs(args, ctx);
	const outputPath = options.outputPath ?? defaultExportPath(ctx);
	writeExport(ctx, outputPath);

	if (options.openInNvim && openInNvim(outputPath, ctx.cwd)) {
		ctx.ui.notify(`Opened session export in nvim: ${outputPath}`, "info");
		return;
	}

	ctx.ui.notify(`Wrote session export: ${outputPath}`, "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("nvim", {
		description: "Export the current session as Markdown and open it in a subprocess nvim",
		handler: exportSession,
	});
}
