import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type ToolResult = { content?: Array<{ type?: string; text?: string }>; details?: unknown };
type Paint = Pick<Theme, "fg" | "bold">;

const clean = (value: unknown) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
const preview = (value: unknown, limit = 72) => { const text = clean(value); return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text; };
const id = (value: unknown) => { const text = clean(value); return text.startsWith("node_") && text.length > 13 ? text.slice(-8) : text || "…"; };
const colorForStatus = (status: string): ThemeColor => ["running", "completed", "active", "accepted", "accept", "integrated", "cleared"].includes(status) ? "success" : ["failed", "rejected", "reject", "error"].includes(status) ? "error" : ["starting", "awaiting-review", "rework", "request-changes", "paused"].includes(status) ? "warning" : "muted";
const value = (theme: Paint, label: string, text: unknown, color: ThemeColor = "muted") => `${theme.fg("dim", `${label}:`)} ${theme.fg(color, preview(text))}`;

export function renderSwarmCall(name: string, args: unknown, theme: Paint) {
	const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
	const action = name.replace(/^swarm_/, "");
	const fields: string[] = [];
	if (input.role) fields.push(theme.fg("accent", clean(input.role)));
	if (input.nodeId) fields.push(theme.fg("accent", id(input.nodeId)));
	if (input.action) fields.push(theme.fg(colorForStatus(clean(input.action)), clean(input.action)));
	if (input.requestId) fields.push(theme.fg("accent", preview(input.requestId, 24)));
	if (input.task) fields.push(value(theme, "task", input.task));
	if (input.body) fields.push(value(theme, "message", input.body));
	if (input.text) fields.push(value(theme, "result", input.text));
	if (input.feedback) fields.push(value(theme, "feedback", input.feedback));
	if (input.verification) fields.push(value(theme, "verified", input.verification));
	return new Text(`${theme.fg("toolTitle", theme.bold(`swarm ${action}`))}${fields.length ? ` ${fields.join(" · ")}` : ""}`, 0, 0);
}

function parse(result: ToolResult): unknown {
	const text = result?.content?.find((part) => part?.type === "text")?.text;
	if (!text) return undefined;
	try { return JSON.parse(text); } catch { return text; }
}

export function renderSwarmResult(name: string, result: ToolResult, theme: Paint) {
	const data = parse(result);
	if (typeof data === "string") return new Text(theme.fg("error", preview(data, 180) || "No result"), 0, 0);
	if (!data || typeof data !== "object") return new Text(theme.fg("error", "Invalid swarm result"), 0, 0);
	let object = data as Record<string, any>;
	if (object.error || object.ok === false) return new Text(`${theme.fg("error", "error")} ${theme.fg("muted", preview(object.error ?? "operation failed", 180))}`, 0, 0);
	// Controller operations are transported in a response envelope. The envelope is
	// intentionally retained for the model, while the UI shows its useful payload.
	if (object.ok === true && object.result && typeof object.result === "object") object = object.result;
	const lines: string[] = [];
	if (object.pending === true) lines.push(theme.fg("warning", "request pending"));
	if (object.status) lines.push(value(theme, "status", object.status, colorForStatus(clean(object.status))));
	const nodes = Array.isArray(object.nodes) ? object.nodes : object.node ? [object.node] : object.nodeId ? [object] : [];
	if (nodes.length) {
		const ids = new Set(nodes.map((node: any) => node.nodeId));
		for (const node of nodes) {
			let depth = 0, parent = node.parentId;
			while (parent && ids.has(parent) && depth < 8) { depth++; parent = nodes.find((item: any) => item.nodeId === parent)?.parentId; }
			const commit = node.integrationCommit ?? node.result?.commit;
			lines.push(`${theme.fg("dim", `${"  ".repeat(depth)}${depth ? "└─ " : ""}`)}${theme.fg("accent", clean(node.role ?? "node"))} ${theme.fg("dim", id(node.nodeId))} ${theme.fg(colorForStatus(clean(node.status)), clean(node.status ?? "unknown"))}${node.task ? ` · ${theme.fg("muted", preview(node.task, 64))}` : ""}${commit ? ` · ${value(theme, "commit", String(commit).slice(0, 12), "success")}` : ""}`);
		}
	}
	if (Array.isArray(object.messages)) for (const message of object.messages.slice(0, 4)) lines.push(`${theme.fg("accent", id(message.fromNodeId))} ${theme.fg("dim", "→")} ${theme.fg("accent", id(message.toNodeId))} · ${theme.fg("muted", preview(message.body, 90))}`);
	if (object.review?.action) lines.push(value(theme, "review", object.review.action, colorForStatus(object.review.action)));
	if (object.commit) lines.push(value(theme, "commit", String(object.commit).slice(0, 12), "success"));
	if (object.integrationCommit) lines.push(value(theme, "integrated", String(object.integrationCommit).slice(0, 12), "success"));
	if (object.result && !nodes.length) lines.push(theme.fg("muted", preview(typeof object.result === "string" ? object.result : JSON.stringify(object.result), 180)));
	if (!lines.length) lines.push(theme.fg("success", `${name.replace(/^swarm_/, "")} succeeded`));
	return new Text(lines.join("\n"), 0, 0);
}
