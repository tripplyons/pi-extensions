import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	truncateTail,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withStatusCard } from "../tool-status-style/style.ts";
import { SwarmRuntime } from "./runtime.ts";
import {
	AGENT_SWARM_ACTIVITY_EVENT,
	MAX_MESSAGE_PREVIEW,
	MAX_PANE_LINES,
	MAX_TEXT_PREVIEW,
	type AgentSwarmDependencies,
	type MessageDetails,
} from "./types.ts";

export { AGENT_SWARM_ACTIVITY_EVENT } from "./types.ts";
export type { AgentSwarmDependencies, NodeRecord } from "./types.ts";

const OBJECTIVE_TOOL_NAME = "swarm_set_objective";

const ObjectiveParams = Type.Object({
	objective: Type.String({ description: "The user-provided objective for the active root swarm" }),
});

const SpawnParams = Type.Object({
	task: Type.String({ description: "Task for the direct child to perform" }),
	dirtyMode: Type.Optional(StringEnum(["exclude", "commit-parent", "commit-child", "shared"] as const)),
});

const SendParams = Type.Object({
	target: Type.String({ description: "Direct parent or child node id" }),
	kind: Type.Optional(StringEnum(["message", "instruction"] as const)),
	body: Type.String({ description: "Message text" }),
});

const ObserveParams = Type.Object({
	target: Type.Optional(Type.String({ description: "Visible node id; defaults to the current node" })),
	lines: Type.Optional(Type.Number({ description: `Pane lines to capture, up to ${MAX_PANE_LINES}` })),
});

const CompleteParams = Type.Object({
	result: Type.String({ description: "Result summary or handoff" }),
});

const ReviewParams = Type.Object({
	target: Type.String({ description: "Direct child awaiting review" }),
	action: StringEnum(["accept", "request-changes", "reject"] as const),
	feedback: Type.Optional(Type.String({ description: "Feedback for request-changes or reject" })),
});

const StopParams = Type.Object({
	target: Type.String({ description: "Visible child node id to stop" }),
});

const RestartParams = Type.Object({
	target: Type.String({ description: "Failed or stopped worker node id to relaunch" }),
});

const CleanupParams = Type.Object({
	target: Type.Optional(Type.String({ description: "Visible completed/rejected node id; omit to clean every eligible terminal worktree" })),
});

const resultText = (text: string) => text.length > MAX_TEXT_PREVIEW ? `${text.slice(0, MAX_TEXT_PREVIEW)}…` : text;
const boundedPreview = (value: unknown, limit: number) => {
	const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "(empty)";
	return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
};
const messagePreview = (value: unknown) => boundedPreview(value, MAX_MESSAGE_PREVIEW);
const textValue = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined;
const toolResultText = (result: { content?: readonly { type?: string; text?: string }[] }) => result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
const toolDetail = (result: { details?: unknown }) => result.details as {
	body?: unknown;
	result?: unknown;
	feedback?: unknown;
	action?: unknown;
	node?: {
		nodeId?: unknown;
		status?: unknown;
		result?: { text?: unknown } | null;
		review?: { feedback?: unknown } | null;
	};
} | undefined;

/**
 * Keep the compact tool row bounded while retaining every detail when the
 * user expands it. Result details are kept separate from the status summary
 * so review feedback and completion bodies cannot be accidentally omitted.
 */
const toolBodyPreview = (result: { content?: readonly { type?: string; text?: string }[]; details?: unknown }, expanded: boolean) => {
	const summary = toolResultText(result);
	const details = toolDetail(result);
	const body = textValue(details?.body) ?? textValue(details?.result) ?? textValue(details?.node?.result?.text);
	const feedback = textValue(details?.feedback) ?? textValue(details?.node?.review?.feedback);
	const sections = [summary];
	if (body && !summary.includes(body)) sections.push(`Result: ${body}`);
	if (feedback && !summary.includes(feedback)) sections.push(`Feedback: ${feedback}`);
	const full = sections.filter(Boolean).join("\n");
	if (expanded) return full;
	const compactFull = full.replace(/\s+/g, " ").trim();
	if (compactFull.length <= MAX_MESSAGE_PREVIEW) return compactFull || "(empty)";
	// Keep each completion/review field represented in a bounded collapsed
	// row instead of allowing a long result to hide review feedback entirely.
	const sectionLimit = Math.max(24, Math.floor((MAX_MESSAGE_PREVIEW - Math.max(0, sections.length - 1)) / Math.max(1, sections.length)));
	return boundedPreview(sections.map((section) => boundedPreview(section, sectionLimit)).join(" "), MAX_MESSAGE_PREVIEW);
};
const textResult = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], ...(details === undefined ? {} : { details }) });
const boundedToolOutput = (runtime: SwarmRuntime, text: string, keep: "head" | "tail") => {
	const truncate = keep === "head" ? truncateHead : truncateTail;
	const initial = truncate(text);
	if (!initial.truncated) return { text, truncation: initial, artifactPath: undefined };
	const artifactPath = runtime.writeOutputArtifact(text);
	const noticeReserve = Buffer.byteLength(artifactPath, "utf8") + 512;
	const truncation = truncate(text, {
		maxBytes: Math.max(1, DEFAULT_MAX_BYTES - noticeReserve),
		maxLines: Math.max(1, DEFAULT_MAX_LINES - 4),
	});
	const notice = `[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output: ${artifactPath}]`;
	return { text: `${truncation.content}${truncation.content ? "\n\n" : ""}${notice}`, truncation, artifactPath };
};
const toolText = (name: string, value: string, theme: Theme) => new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", value)}`, 0, 0);

export function createAgentSwarmExtension(pi: ExtensionAPI, dependencies: AgentSwarmDependencies = {}) {
	const runtime = new SwarmRuntime(pi, dependencies);
	const syncObjectiveToolVisibility = () => {
		const activeTools = pi.getActiveTools();
		const objectiveToolActive = activeTools.includes(OBJECTIVE_TOOL_NAME);
		const objectiveNeeded = runtime.needsObjective();
		if (objectiveNeeded === objectiveToolActive) return;
		pi.setActiveTools(objectiveNeeded
			? [...new Set([...activeTools, OBJECTIVE_TOOL_NAME])]
			: activeTools.filter((name) => name !== OBJECTIVE_TOOL_NAME));
	};
	pi.events.on(AGENT_SWARM_ACTIVITY_EVENT, (value) => runtime.activityOccurred(value));

	pi.on("session_start", async (_event, ctx) => {
		try {
			await runtime.startSession(ctx);
			syncObjectiveToolVisibility();
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? `agent-swarm: ${error.message}` : `agent-swarm: ${String(error)}`, "error");
		}
	});

	pi.on("before_agent_start", async (event) => runtime.beforeAgentStart(event.systemPrompt, event.prompt));
	pi.on("agent_start", async () => runtime.agentStarted());
	pi.on("agent_end", async (event) => runtime.agentEnded(event));
	pi.on("agent_settled", async (_event, ctx) => runtime.agentSettled(ctx));
	pi.on("session_before_compact", async (event) => runtime.beforeCompaction(event));
	pi.on("session_compact", async (event, ctx) => runtime.compactionSucceeded(event, ctx));
	pi.on("session_shutdown", async (event) => runtime.stopSession(event.reason));
	pi.registerMessageRenderer<MessageDetails>("agent-swarm-inbox", (message, { expanded }, theme) => {
		const details = message.details;
		const kind = details?.kind ?? "message";
		const from = details?.fromNodeId ?? "unknown";
		const to = details?.toNodeId ?? "current";
		const body = details?.body ?? message.content;
		const header = `${theme.fg("accent", "agent-swarm")} ${theme.fg("muted", `← ${kind}`)} ${theme.fg("dim", `${from} → ${to}`)} ${theme.fg("dim", details?.messageId ?? "")}`;
		const preview = theme.fg("toolOutput", messagePreview(body));
		return new Text(expanded ? `${header}\n\n${theme.fg("toolOutput", message.content)}` : `${header}: ${preview}`, 0, 0);
	});

	const usage = "Usage: /swarm:start [objective] | /swarm:tree | /swarm:status | /swarm:pause | /swarm:resume [runId] | /swarm:runs | /swarm:kill | /swarm:clear | /swarm:help";
	const guardedCommand = (handler: (args: string, ctx: ExtensionContext) => Promise<void> | void) => async (args: string, ctx: ExtensionContext) => {
		try {
			await handler(args, ctx);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};
	const requireNoArgs = (args: string, command: string) => {
		if (args?.trim()) throw new Error(`Usage: /${command}`);
	};
	const startCommand = guardedCommand(async (args, ctx) => {
		if (runtime.isAttached()) return;
		const run = runtime.activateRoot(ctx, args?.trim() ?? "");
		if (!run) return;
		syncObjectiveToolVisibility();
		ctx.ui.notify(`Swarm root active: ${run.runId}\nCurrent Pi session is ${run.rootNodeId}. Use swarm_spawn to add direct children.`, "info");
	});
	const treeCommand = guardedCommand(async (args, ctx) => {
		requireNoArgs(args, "swarm:tree");
		if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.custom === "function") await runtime.openTree(ctx);
		else ctx.ui.notify(runtime.tree().text, "info");
	});
	const statusCommand = guardedCommand((args, ctx) => {
		requireNoArgs(args, "swarm:status");
		ctx.ui.notify(runtime.tree().text, "info");
	});
	const pauseCommand = guardedCommand((args, ctx) => {
		requireNoArgs(args, "swarm:pause");
		const run = runtime.pause();
		ctx.ui.notify(`Swarm paused: ${run.runId}. Workers remain in their tmux panes; resume with /swarm:resume ${run.runId}.`, "info");
	});
	const resumeCommand = guardedCommand(async (args, ctx) => {
		const run = await runtime.resume(args?.trim() || undefined, ctx);
		syncObjectiveToolVisibility();
		ctx.ui.notify(`Swarm resumed: ${run.runId}. Use /swarm:tree to monitor it.`, "info");
	});
	const runsCommand = guardedCommand((args, ctx) => {
		requireNoArgs(args, "swarm:runs");
		const runs = runtime.resumableRuns();
		ctx.ui.notify(runs.length === 0 ? "No resumable swarm runs found." : runs.map((run) => `${run.runId} [${run.status}] root=${run.rootNodeId} created=${new Date(run.createdAt).toISOString()}`).join("\n"), "info");
	});
	const killCommand = guardedCommand((args, ctx) => {
		requireNoArgs(args, "swarm:kill");
		const result = runtime.kill();
		ctx.ui.notify(`Swarm workers stopped: ${result.stoppedNodeIds.length}. tmux session killed: ${result.killed ? "yes" : "no"}. Use /swarm:clear to remove durable state.`, "info");
	});
	const clearCommand = guardedCommand((args, ctx) => {
		requireNoArgs(args, "swarm:clear");
		const result = runtime.clear();
		syncObjectiveToolVisibility();
		ctx.ui.notify(`Swarm cleared: ${result.stoppedNodeIds.length} worker(s) stopped, ${result.removedWorktrees.length} worktree(s) removed.`, "info");
	});
	const helpCommand = guardedCommand((args, ctx) => {
		requireNoArgs(args, "swarm:help");
		ctx.ui.notify(`${usage}. Commands use colon syntax; /swarm and the old space-separated form are not registered.`, "info");
	});

	pi.registerCommand("swarm:start", {
		description: "Activate the current Pi session as the agent-swarm root: /swarm:start [objective]",
		handler: startCommand,
	});
	pi.registerCommand("swarm:tree", {
		description: "Open the fullscreen agent-swarm hierarchy navigator",
		handler: treeCommand,
	});
	pi.registerCommand("swarm:status", {
		description: "Show the visible agent-swarm hierarchy and statuses",
		handler: statusCommand,
	});
	pi.registerCommand("swarm:pause", {
		description: "Pause swarm coordination while preserving workers and durable state",
		handler: pauseCommand,
	});
	pi.registerCommand("swarm:resume", {
		description: "Reconnect this Pi session to a paused or active swarm: /swarm:resume [runId]",
		handler: resumeCommand,
	});
	pi.registerCommand("swarm:runs", {
		description: "List active and paused swarm runs that can be resumed",
		handler: runsCommand,
	});
	pi.registerCommand("swarm:kill", {
		description: "Stop all workers and kill the current swarm tmux session",
		handler: killCommand,
	});
	pi.registerCommand("swarm:clear", {
		description: "Kill all workers and clear the current swarm state and clean worktrees",
		handler: clearCommand,
	});
	pi.registerCommand("swarm:help", {
		description: "Show agent-swarm slash command help",
		handler: helpCommand,
	});

	pi.registerTool(withStatusCard({
		name: OBJECTIVE_TOOL_NAME,
		label: "Swarm set objective",
		description: "Set the active root swarm's objective. This tool is available only while the root has no objective.",
		promptSnippet: "Set the missing objective for the active root swarm",
		promptGuidelines: [
			"When swarm_set_objective is available, ask the user for the swarm objective with ask_user unless the user already supplied it; never infer an objective.",
		],
		parameters: ObjectiveParams,
		async execute(_toolCallId, params) {
			try {
				const node = runtime.setObjective(params.objective);
				return textResult(`Swarm objective set: ${node.task}`, { node });
			} finally {
				syncObjectiveToolVisibility();
			}
		},
		renderCall(args, theme) { return toolText(OBJECTIVE_TOOL_NAME, resultText(args.objective ?? ""), theme); },
		renderResult(result, _options, theme) { return new Text(theme.fg("muted", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_spawn",
		label: "Swarm spawn",
		description: "Spawn an interactive child Pi worker in the current hierarchy. The user must first activate this session with /swarm:start; worker extensions are fixed by user dotfiles and cannot be selected by agents.",
		promptSnippet: "Spawn a direct child Pi worker with tmux, hierarchy, inbox, and an isolated Git worktree",
		promptGuidelines: [
			"Run /swarm:start yourself before asking an agent to delegate; tools cannot create a root swarm.",
			"After a dirty-worktree rejection, a swarm root must ask the user which dirtyMode to use; a worker must request that decision from its direct parent with swarm_send instead of prompting in its hidden pane.",
			"Use the returned node id for follow-up messages and review.",
		],
		parameters: SpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const details = await runtime.spawn(params.task, params.dirtyMode, ctx);
			return textResult(`Spawned ${details.node.nodeId} in ${details.node.status} (${details.worktreeMode}). tmux=${details.node.tmuxSession}:${details.node.tmuxWindow}${details.node.worktreePath ? ` worktree=${details.node.worktreePath}` : " shared=true"}`, details);
		},
		renderCall(args, theme) { return toolText("swarm_spawn", resultText(args.task ?? ""), theme); },
		renderResult(result, _options, theme) { return new Text(theme.fg("muted", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_send",
		label: "Swarm send",
		description: `Send a message or authoritative instruction to a direct parent or child. Messages are durable and delivered through Pi steering. Tool output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Send a direct parent/child swarm message or instruction",
		parameters: SendParams,
		async execute(_toolCallId, params) {
			const message = runtime.send(params.target, params.kind ?? "message", params.body);
			const output = boundedToolOutput(runtime, `Queued ${message.kind} ${message.messageId} for ${message.toNodeId}: ${message.body}`, "head");
			return textResult(output.text, { messageId: message.messageId, fromNodeId: message.fromNodeId, toNodeId: message.toNodeId, kind: message.kind, body: message.body, truncation: output.truncation, ...(output.artifactPath ? { outputArtifactPath: output.artifactPath } : {}) });
		},
		renderCall(args, theme) { return toolText("swarm_send", `${args.kind ?? "message"} → ${args.target ?? "?"}: ${messagePreview(args.body)}`, theme); },
		renderResult(result, options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const body = (result.details as { body?: unknown } | undefined)?.body;
			const fullText = typeof body === "string" && body && !text.includes(body) ? `${text}: ${body}` : text;
			return new Text(theme.fg("muted", options?.expanded ? fullText : messagePreview(fullText)), 0, 0);
		},
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_task",
		label: "Swarm task",
		description: `Read the current node's durable worker assignment or root objective. The full text is kept in durable swarm state rather than repeated in every prompt. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Read this swarm node's durable assignment or objective",
		parameters: Type.Object({}),
		async execute() {
			const output = boundedToolOutput(runtime, runtime.task(), "head");
			return textResult(output.text, { truncation: output.truncation, ...(output.artifactPath ? { artifactPath: output.artifactPath } : {}) });
		},
		renderCall(_args, theme) { return toolText("swarm_task", "read assignment", theme); },
		renderResult(result, _options, theme) { return new Text(theme.fg("toolOutput", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_tree",
		label: "Swarm tree",
		description: `Show the visible parent/child hierarchy, lifecycle states, worktrees, and tmux windows. Workers see direct relatives; the root sees its full tree. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Inspect the current swarm hierarchy and statuses",
		parameters: Type.Object({}),
		async execute() {
			const tree = runtime.tree();
			const output = boundedToolOutput(runtime, tree.text, "head");
			return textResult(output.text, { nodes: tree.nodes, rootId: tree.rootId, truncation: output.truncation, ...(output.artifactPath ? { artifactPath: output.artifactPath } : {}) });
		},
		renderCall(_args, theme) { return toolText("swarm_tree", "inspect hierarchy", theme); },
		renderResult(result, _options, theme) { return new Text(theme.fg("toolOutput", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_observe",
		label: "Swarm observe",
		description: `Capture a visible child/parent tmux pane for relationship monitoring. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Observe a visible swarm node's tmux pane",
		parameters: ObserveParams,
		async execute(_toolCallId, params) {
			const observed = runtime.observe(params.target, params.lines);
			const output = boundedToolOutput(runtime, observed.output, "tail");
			return textResult(`${observed.node.nodeId} [${observed.node.status}]\n\n${output.text}`, { node: observed.node, truncation: output.truncation, ...(output.artifactPath ? { artifactPath: output.artifactPath } : {}) });
		},
		renderCall(args, theme) { return toolText("swarm_observe", args.target ?? "current", theme); },
		renderResult(result, _options, theme) { return new Text(theme.fg("toolOutput", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_complete",
		label: "Swarm complete",
		description: "Submit a worker result for direct-parent review. This does not merge the worker branch.",
		promptSnippet: "Submit this worker's result for parent acceptance",
		parameters: CompleteParams,
		async execute(_toolCallId, params) {
			const message = runtime.complete(params.result);
			return textResult(`Submitted ${message.messageId} for review by ${message.toNodeId}`, { messageId: message.messageId, toNodeId: message.toNodeId, kind: message.kind, body: message.body });
		},
		renderCall(args, theme) { return toolText("swarm_complete", `submit for review: ${messagePreview(args.result)}`, theme); },
		renderResult(result, options, theme) { return new Text(theme.fg("muted", toolBodyPreview(result, options?.expanded ?? false)), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_review",
		label: "Swarm review",
		description: "Review a direct child's result: accept, request changes, or reject. Acceptance leaves the child branch as an explicit Git handoff.",
		promptSnippet: "Accept, request changes, or reject a direct child result",
		parameters: ReviewParams,
		async execute(_toolCallId, params) {
			const node = runtime.review(params.target, params.action, params.feedback);
			return textResult(`${node.nodeId} ${node.status}`, { action: params.action, node });
		},
		renderCall(args, theme) {
			const feedback = args.feedback ? `: ${messagePreview(args.feedback)}` : "";
			return toolText("swarm_review", `${args.action ?? "?"} ${args.target ?? "?"}${feedback}`, theme);
		},
		renderResult(result, options, theme) { return new Text(theme.fg("muted", toolBodyPreview(result, options?.expanded ?? false)), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_restart",
		label: "Swarm restart",
		description: "Relaunch a failed or stopped worker in place. Reuses the same node id, worktree, branch, task, inbox, and session id.",
		promptSnippet: "Restart a failed or stopped direct child, or any descendant from the root",
		parameters: RestartParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const node = await runtime.restart(params.target, ctx);
			return textResult(`Restarted ${node.nodeId} in ${node.status}`, { node });
		},
		renderCall(args, theme) { return toolText("swarm_restart", args.target ?? "?", theme); },
		renderResult(result, _options, theme) { return new Text(theme.fg("muted", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_stop",
		label: "Swarm stop",
		description: "Stop a direct child, or use root emergency authority for any descendant. Stopped worktrees are retained and not deleted.",
		promptSnippet: "Stop a direct child or root-visible swarm descendant",
		parameters: StopParams,
		async execute(_toolCallId, params) {
			const node = runtime.stop(params.target);
			return textResult(`${node.nodeId} ${node.status}`, { node });
		},
		renderCall(args, theme) { return toolText("swarm_stop", args.target ?? "?", theme); },
		renderResult(result, _options, theme) { return new Text(theme.fg("muted", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_kill",
		label: "Swarm kill",
		description: "Stop every worker in the root swarm and kill its tmux session while retaining durable state for inspection or clearing.",
		promptSnippet: "Kill all workers and the swarm tmux session",
		parameters: Type.Object({}),
		async execute() {
			const result = runtime.kill();
			return textResult(`Stopped ${result.stoppedNodeIds.length} worker(s); tmux session ${result.tmuxSession} ${result.killed ? "killed" : "was not running"}.`, result);
		},
		renderCall(_args, theme) { return toolText("swarm_kill", "stop all workers", theme); },
		renderResult(result, _options, theme) { return new Text(theme.fg("muted", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_clear",
		label: "Swarm clear",
		description: "Kill all workers, remove clean generated worktrees, and clear the root swarm's durable state. Refuses dirty worktrees.",
		promptSnippet: "Kill and clear the entire root swarm setup",
		parameters: Type.Object({}),
		async execute() {
			const result = runtime.clear();
			syncObjectiveToolVisibility();
			return textResult(`Cleared swarm ${result.runId}; removed ${result.removedWorktrees.length} worktree(s).`, result);
		},
		renderCall(_args, theme) { return toolText("swarm_clear", "kill and clear setup", theme); },
		renderResult(result, _options, theme) { return new Text(theme.fg("muted", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0); },
	}));

	pi.registerTool(withStatusCard({
		name: "swarm_cleanup",
		label: "Swarm cleanup",
		description: "Remove a clean terminal child worktree while preserving its generated branch and durable record. Omit target to clean every eligible terminal worktree.",
		promptSnippet: "Remove a clean completed swarm worktree without deleting its branch",
		parameters: CleanupParams,
		async execute(_toolCallId, params) {
			const cleaned = runtime.cleanup(params.target);
			if ("nodes" in cleaned) {
				const ids = cleaned.nodes.map((node) => node.nodeId);
				return textResult(ids.length === 0 ? "No eligible worktrees to clean" : `Cleaned ${ids.length} worktree(s): ${ids.join(", ")}`, cleaned);
			}
			return textResult(`${cleaned.nodeId} worktree cleanup complete`, { node: cleaned });
		},
		renderCall(args, theme) { return toolText("swarm_cleanup", args.target ?? "eligible terminal worktrees", theme); },
		renderResult(result, _options, theme) { return new Text(theme.fg("muted", result.content[0]?.type === "text" ? result.content[0].text : ""), 0, 0); },
	}));
}

export default createAgentSwarmExtension;
