import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

/** The subset of a swarm node that is needed by the tree view. */
export interface SwarmTreeNode {
	nodeId: string;
	parentId: string | null;
	childIds: readonly string[];
	task: string;
	status: string;
	version?: number;
	role?: string;
	createdAt?: number;
	updatedAt?: number;
	sessionId?: string | null;
	sessionName?: string | null;
	cwd?: string;
	worktreePath?: string | null;
	branch?: string | null;
	sharedDirectory?: boolean;
	tmuxSession?: string | null;
	tmuxWindow?: string | null;
	model?: string | null;
	thinking?: string | null;
	result?: { text: string; artifactPath?: string; submittedAt?: number } | null;
	review?: { action: string; feedback?: string; updatedAt?: number } | null;
	failure?: string | null;
	readyAt?: number | null;
	cleanedAt?: number | null;
}
export interface SwarmTreeData {
	nodes: readonly SwarmTreeNode[];
	rootId: string;
}

export interface SwarmTreeRow {
	node: SwarmTreeNode;
	prefix: string;
	depth: number;
	isLast: boolean;
}

export type SwarmTreeOutputReader = (node: SwarmTreeNode) => string | null;

/** Workers that have not changed state for this long deserve an operator glance. */
export const STALE_WORKER_THRESHOLD_MS = 5 * 60 * 1000;
/** After this longer quiet period, tell the operator to restart or stop. */
export const STALE_WORKER_ESCALATE_MS = 15 * 60 * 1000;

const TERMINAL_STATUSES = new Set(["completed", "rejected", "failed", "stopped"]);
const STALE_STATUSES = new Set(["starting", "ready", "running", "rework"]);

const STATUS_GLYPHS: Record<string, string> = {
	starting: "◌",
	ready: "○",
	running: "●",
	"awaiting-review": "◈",
	rework: "↻",
	completed: "✓",
	rejected: "×",
	failed: "!",
	stopped: "■",
};

const STATUS_COLORS: Record<string, "success" | "warning" | "error" | "accent" | "muted" | "dim"> = {
	starting: "warning",
	ready: "accent",
	running: "success",
	"awaiting-review": "warning",
	rework: "warning",
	completed: "success",
	rejected: "error",
	failed: "error",
	stopped: "muted",
};

const shortText = (value: string, limit = 100) => {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
};

const childrenFor = (node: SwarmTreeNode, byId: Map<string, SwarmTreeNode>, byParent: Map<string | null, SwarmTreeNode[]>) => {
	const listed = node.childIds.map((childId) => byId.get(childId)).filter((child): child is SwarmTreeNode => child !== undefined);
	const listedIds = new Set(listed.map((child) => child.nodeId));
	const unlisted = (byParent.get(node.nodeId) ?? []).filter((child) => !listedIds.has(child.nodeId));
	return [...listed, ...unlisted];
};

/**
 * Flatten a visible node set while retaining the hierarchy connectors. A
 * worker's visibility is intentionally not rooted at the run root, so a
 * missing parent is treated as the visible tree's root instead of dropping
 * the node entirely.
 */
export const buildTreeRows = (nodes: readonly SwarmTreeNode[], rootId: string): SwarmTreeRow[] => {
	const byId = new Map(nodes.map((node) => [node.nodeId, node]));
	const byParent = new Map<string | null, SwarmTreeNode[]>();
	for (const node of nodes) byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node]);

	const roots = byId.has(rootId)
		? [byId.get(rootId)!]
		: nodes.filter((node) => node.parentId === null || !byId.has(node.parentId));
	const candidates = roots.length > 0 ? roots : nodes.slice(0, 1);
	const rows: SwarmTreeRow[] = [];
	const visited = new Set<string>();
	const visit = (node: SwarmTreeNode, ancestorsLast: boolean[], isLast: boolean, rootHasConnector: boolean) => {
		if (visited.has(node.nodeId)) return;
		visited.add(node.nodeId);
		const prefix = ancestorsLast.length === 0 && !rootHasConnector
			? ""
			: `${ancestorsLast.slice(0, -1).map((ancestorIsLast) => ancestorIsLast ? "   " : "│  ").join("")}${isLast ? "└─ " : "├─ "}`;
		rows.push({ node, prefix, depth: ancestorsLast.length, isLast });
		const children = childrenFor(node, byId, byParent);
		children.forEach((child, index) => visit(child, [...ancestorsLast, isLast], index === children.length - 1, rootHasConnector));
	};

	const rootHasConnector = candidates.length > 1;
	candidates.forEach((node, index) => visit(node, [], index === candidates.length - 1, rootHasConnector));
	// A malformed record can leave nodes disconnected from every candidate. Do
	// not hide them from the user; display each remaining component as a root.
	for (const node of nodes) {
		if (!visited.has(node.nodeId)) visit(node, [], true, true);
	}
	return rows;
};

export const formatTime = (timestamp: number | null | undefined) => timestamp === undefined || timestamp === null ? "—" : new Date(timestamp).toISOString();

/** Keep durations compact enough for the narrow details pane. */
export const formatDuration = (milliseconds: number | undefined) => {
	if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "—";
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (totalSeconds < 1) return "<1s";
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 1) return `${seconds}s`;
	const minutes = totalMinutes % 60;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 1) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	const hours = totalHours % 24;
	const totalDays = Math.floor(totalHours / 24);
	if (totalDays < 1) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
	return `${totalDays}d ${hours.toString().padStart(2, "0")}h`;
};

/** Return the elapsed lifetime at a stable observation point. */
export const durationForNode = (node: SwarmTreeNode, observedAt = Date.now()) => {
	if (node.createdAt === undefined) return undefined;
	const end = TERMINAL_STATUSES.has(node.status) && node.updatedAt !== undefined ? node.updatedAt : observedAt;
	return Math.max(0, end - node.createdAt);
};

/**
 * A waiting-for-review child is intentionally quiet, so do not label it stale.
 * Only workers (never the root) in an active execution state are considered.
 */
export const isStaleWorker = (node: SwarmTreeNode, observedAt = Date.now(), thresholdMs = STALE_WORKER_THRESHOLD_MS) =>
	node.role !== "root" && STALE_STATUSES.has(node.status) && node.updatedAt !== undefined &&
	observedAt >= node.updatedAt && observedAt - node.updatedAt >= thresholdMs;

export const isEscalatedStaleWorker = (node: SwarmTreeNode, observedAt = Date.now(), thresholdMs = STALE_WORKER_ESCALATE_MS) =>
	isStaleWorker(node, observedAt, thresholdMs);

const wrapText = (value: string, width: number) => {
	if (width <= 1) return [shortText(value, width)];
	const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		if (!line) {
			line = word;
			continue;
		}
		if (line.length + 1 + word.length <= width) line += ` ${word}`;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line) lines.push(line);
	return lines.flatMap((item) => item.length > width ? item.match(new RegExp(`.{1,${Math.max(1, width)}}`, "g")) ?? [item] : [item]);
};

const detailLinesFor = (node: SwarmTreeNode, width: number): string[] => {
	const observedAt = Date.now();
	const stale = isStaleWorker(node, observedAt);
	const lines: string[] = [
		`Node: ${node.nodeId}`,
		`Status: ${node.status}`,
		`Role: ${node.role ?? "worker"}`,
		`Last activity: ${formatTime(node.updatedAt)}`,
		`Duration: ${formatDuration(durationForNode(node, observedAt))}`,
		`Children: ${node.childIds.length}`,
		"",
		"Task:",
	];
	if (stale) {
		const escalated = isEscalatedStaleWorker(node, observedAt);
		lines.push(
			"",
			escalated ? "Warning: worker is stale" : "Warning: worker may be stale",
			`  No activity for ${formatDuration(observedAt - node.updatedAt!)}`,
			escalated
				? `  Inspect with swarm_observe ${node.nodeId}; then swarm_restart or swarm_stop.`
				: `  Inspect with swarm_observe ${node.nodeId}; stop with swarm_stop if needed.`,
		);
	}
	if (node.status === "awaiting-review") {
		lines.push("", "Action:", `  Review with swarm_review ${node.nodeId} (accept/request-changes/reject).`);
	} else if (TERMINAL_STATUSES.has(node.status) && node.worktreePath && !node.cleanedAt) {
		lines.push(
			"",
			"Cleanup:",
			`  Run swarm_cleanup ${node.nodeId} after verifying the branch handoff.`,
			"  The worktree must be clean; the generated branch is retained.",
		);
	}
	lines.push(...wrapText(node.task, Math.max(1, width - 2)).map((line) => `  ${line}`));
	lines.push(
		"",
		`CWD: ${node.cwd ?? "—"}`,
		`Branch: ${node.branch ?? "—"}`,
		`Worktree: ${node.worktreePath ?? (node.sharedDirectory ? "shared directory" : "—")}`,
		`Session: ${node.sessionId ?? "—"}${node.sessionName ? ` (${node.sessionName})` : ""}`,
		`tmux: ${node.tmuxSession && node.tmuxWindow ? `${node.tmuxSession}:${node.tmuxWindow}` : "—"}`,
		`Model: ${node.model ?? "—"}`,
		`Thinking: ${node.thinking ?? "—"}`,
		`Created: ${formatTime(node.createdAt)}`,
	);
	if (node.readyAt !== undefined && node.readyAt !== null) lines.push(`Ready: ${formatTime(node.readyAt)}`);
	if (node.result) {
		lines.push("", "Result:");
		lines.push(...wrapText(node.result.text, Math.max(1, width - 2)).map((line) => `  ${line}`));
		if (node.result.artifactPath) lines.push(`  Artifact: ${node.result.artifactPath}`);
	}
	if (node.review) {
		lines.push("", `Review: ${node.review.action}`);
		if (node.review.feedback) lines.push(...wrapText(node.review.feedback, Math.max(1, width - 2)).map((line) => `  ${line}`));
	}
	if (node.failure) lines.push("", ...wrapText(`Failure: ${node.failure}`, Math.max(1, width)));
	if (node.cleanedAt !== undefined && node.cleanedAt !== null) lines.push(`Cleaned: ${formatTime(node.cleanedAt)}`);
	return lines;
};

export class SwarmTreeView implements Component {
	private data: SwarmTreeData;
	private selectedNodeId: string;
	private showInactiveAgents = false;
	private showLiveOutput = true;
	private followLiveOutput = true;
	private panelScroll = 0;
	private panelMaxStart = 0;
	private closed = false;
	private readonly readData?: () => SwarmTreeData;
	private readonly readOutput?: SwarmTreeOutputReader;
	private refreshError: string | null = null;
	private outputError: string | null = null;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		data: SwarmTreeData,
		private readonly onClose: () => void,
		readData?: () => SwarmTreeData,
		readOutput?: SwarmTreeOutputReader,
	) {
		this.data = data;
		this.readData = readData;
		this.readOutput = readOutput;
		this.selectedNodeId = this.visibleNodes(data).find((node) => node.nodeId === data.rootId)?.nodeId ?? this.visibleNodes(data)[0]?.nodeId ?? "";
	}

	setData(data: SwarmTreeData) {
		this.data = data;
		const visibleNodes = this.visibleNodes(data);
		if (!visibleNodes.some((node) => node.nodeId === this.selectedNodeId)) {
			this.selectedNodeId = visibleNodes.find((node) => node.nodeId === data.rootId)?.nodeId ?? visibleNodes[0]?.nodeId ?? "";
			this.resetPanel();
		}
		this.invalidate();
	}

	getSelectedNodeId() {
		return this.selectedNodeId;
	}

	getShowInactiveAgents() {
		return this.showInactiveAgents;
	}

	getShowLiveOutput() {
		return this.showLiveOutput;
	}

	handleInput(data: string) {
		if (this.closed) return;
		// Check escape before printable keys only after the arrow sequences have
		// been recognized by matchesKey; a bare ESC remains the close command.
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.closed = true;
			this.onClose();
			return;
		}
		if (data === " ") {
			this.showInactiveAgents = !this.showInactiveAgents;
			this.setData(this.data);
			this.tui.requestRender();
			return;
		}
		if (data === "o" || data === "O") {
			const selected = this.data.nodes.find((node) => node.nodeId === this.selectedNodeId);
			if (!selected?.tmuxSession || !selected.tmuxWindow || !this.readOutput) return;
			this.resetPanel(!this.showLiveOutput);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (data === "[") {
			this.followLiveOutput = false;
			this.panelScroll = Math.max(0, this.panelScroll - 1);
			this.tui.requestRender();
			return;
		}
		if (data === "]") {
			this.panelScroll = Math.min(this.panelMaxStart, this.panelScroll + 1);
			this.followLiveOutput = this.showLiveOutput && this.panelScroll >= this.panelMaxStart;
			this.tui.requestRender();
			return;
		}
		const rows = buildTreeRows(this.visibleNodes(), this.data.rootId);
		const currentIndex = Math.max(0, rows.findIndex((row) => row.node.nodeId === this.selectedNodeId));
		let nextIndex: number | undefined;
		if (data === "j" || matchesKey(data, "down")) nextIndex = currentIndex + 1;
		else if (data === "k" || matchesKey(data, "up")) nextIndex = currentIndex - 1;
		else if (data === "g" || matchesKey(data, "home")) nextIndex = 0;
		else if (data === "G" || matchesKey(data, "end")) nextIndex = rows.length - 1;
		else if (matchesKey(data, "pageDown") || data === "\u0004") nextIndex = currentIndex + Math.max(1, Math.floor(rows.length / 2));
		else if (matchesKey(data, "pageUp") || data === "\u0015") nextIndex = currentIndex - Math.max(1, Math.floor(rows.length / 2));
		else if (data === "h" || matchesKey(data, "left")) {
			const node = rows[currentIndex]?.node;
			const parentIndex = node?.parentId ? rows.findIndex((row) => row.node.nodeId === node.parentId) : -1;
			if (parentIndex >= 0) nextIndex = parentIndex;
		} else if (data === "l" || matchesKey(data, "right")) {
			const node = rows[currentIndex]?.node;
			const childIndex = node?.childIds.map((childId) => rows.findIndex((row) => row.node.nodeId === childId)).find((index) => index !== undefined && index >= 0) ?? -1;
			if (childIndex >= 0) nextIndex = childIndex;
		}
		if (nextIndex === undefined || rows.length === 0) return;
		const bounded = Math.min(rows.length - 1, Math.max(0, nextIndex));
		const nextNodeId = rows[bounded]?.node.nodeId;
		if (!nextNodeId || nextNodeId === this.selectedNodeId) return;
		this.selectedNodeId = nextNodeId;
		this.resetPanel();
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		this.refreshData();
		const terminalWidth = Math.max(1, Math.floor(width || this.tui.terminal.columns || 1));
		const terminalRows = Math.max(1, Math.floor(this.tui.terminal.rows || 1));
		const visibleNodes = this.visibleNodes();
		const rows = buildTreeRows(visibleNodes, this.data.rootId);
		const selectedIndex = Math.max(0, rows.findIndex((row) => row.node.nodeId === this.selectedNodeId));
		const selected = rows[selectedIndex]?.node ?? visibleNodes[0];
		const separatorWidth = 1;
		if (terminalWidth <= separatorWidth) {
			return [truncateToWidth(selected?.nodeId ?? "Swarm tree", terminalWidth, "", true)];
		}
		const availableWidth = Math.max(1, terminalWidth - separatorWidth);
		const minimumLeft = availableWidth >= 52 ? 24 : Math.max(1, Math.floor(availableWidth / 2));
		const leftWidth = Math.min(Math.max(minimumLeft, Math.floor(availableWidth * 0.46)), availableWidth);
		const rightWidth = Math.max(0, availableWidth - leftWidth);
		const separator = this.paint("borderMuted", "│");
		const pair = (left: string, right: string) => `${truncateToWidth(left, leftWidth, "", true)}${separator}${truncateToWidth(right, rightWidth, "", true)}`;
		const title = this.paint("accent", this.bold("Swarm tree"));
		const selectedTitle = selected
			? this.paint("muted", `${selected.tmuxSession && selected.tmuxWindow ? "Live • " : ""}${selected.nodeId}`)
			: this.paint("dim", "No visible swarm nodes");
		const header = pair(title, selectedTitle);
		if (terminalRows === 1) return [header];

		const bodyRows = terminalRows - 2;
		const maxStart = Math.max(0, rows.length - bodyRows);
		const start = Math.min(maxStart, Math.max(0, selectedIndex - Math.floor(bodyRows / 2)));
		const details = selected ? detailLinesFor(selected, rightWidth) : [this.showInactiveAgents ? "No swarm nodes" : "No active swarm nodes"];
		const liveAvailable = Boolean(selected?.tmuxSession && selected.tmuxWindow && this.readOutput);
		const liveOutput = this.showLiveOutput && liveAvailable && selected ? this.readLiveOutput(selected) : null;
		const panelHeader = liveOutput === null
			? []
			: [this.paint("accent", "Live output"), `tmux: ${selected!.tmuxSession}:${selected!.tmuxWindow}`];
		const panel = liveOutput === null
			? details
			: (liveOutput.trimEnd() || "No pane output yet.").split("\n").map((line) => truncateToWidth(line, Math.max(1, rightWidth), "", true));
		if (this.refreshError) panelHeader.unshift(`Refresh error: ${this.refreshError}`);
		if (this.outputError) panelHeader.unshift(`Live refresh error: ${this.outputError}`);
		const panelViewportRows = Math.max(0, bodyRows - panelHeader.length);
		this.panelMaxStart = Math.max(0, panel.length - panelViewportRows);
		this.panelScroll = liveOutput !== null && this.followLiveOutput
			? this.panelMaxStart
			: Math.min(this.panelMaxStart, Math.max(0, this.panelScroll));
		const output = [header];
		for (let offset = 0; offset < bodyRows; offset++) {
			const row = rows[start + offset];
			let left = "";
			if (row) {
				const glyph = STATUS_GLYPHS[row.node.status] ?? "•";
				const coloredGlyph = this.paint(STATUS_COLORS[row.node.status] ?? "muted", glyph);
				const label = `${coloredGlyph} ${row.node.nodeId}  ${this.paint("dim", shortText(row.node.task, Math.max(20, leftWidth - row.prefix.length - 18)))}`;
				left = `${row.prefix}${row.node.nodeId === this.selectedNodeId ? this.paint("accent", "▸") : " "} ${label}`;
				if (row.node.nodeId === this.selectedNodeId) left = this.background("selectedBg", this.paint("accent", left));
			}
			const detail = offset < panelHeader.length
				? panelHeader[offset]!
				: panel[this.panelScroll + offset - panelHeader.length] ?? "";
			output.push(pair(left, detail));
		}
		const scrollHint = rows.length > bodyRows ? ` ${start > 0 ? "↑" : " "}${start + bodyRows < rows.length ? "↓" : " "}` : "";
		const visibilityHint = this.showInactiveAgents ? "space hide inactive" : "space show inactive";
		const panelHint = liveAvailable
			? `${this.showLiveOutput ? "live auto-refresh • o details" : "o live"} • [/] scroll`
			: "[/] scroll";
		const panelScrollHint = panel.length > panelViewportRows ? ` ${this.panelScroll > 0 ? "↑" : " "}${this.panelScroll + panelViewportRows < panel.length ? "↓" : " "}` : "";
		output.push(pair(this.paint("dim", `j/k or ↑/↓ • h/l • ${visibilityHint} • q/esc`), this.paint("dim", `${panelHint} • ${rows.length} nodes${scrollHint}${panelScrollHint}`)));
		return output;
	}

	invalidate() {}

	dispose() {
		this.closed = true;
	}

	private resetPanel(showLiveOutput = true) {
		this.showLiveOutput = showLiveOutput;
		this.followLiveOutput = true;
		this.panelScroll = 0;
		this.outputError = null;
	}

	private paint(color: "accent" | "borderMuted" | "success" | "warning" | "error" | "muted" | "dim", value: string) {
		return typeof this.theme.fg === "function" ? this.theme.fg(color, value) : value;
	}

	private background(color: "selectedBg", value: string) {
		const theme = this.theme as Theme & { bg?: (name: "selectedBg", text: string) => string };
		return typeof theme.bg === "function" ? theme.bg(color, value) : value;
	}

	private bold(value: string) {
		return typeof this.theme.bold === "function" ? this.theme.bold(value) : value;
	}

	private visibleNodes(data = this.data) {
		return this.showInactiveAgents ? [...data.nodes] : data.nodes.filter((node) => !TERMINAL_STATUSES.has(node.status));
	}

	private refreshData() {
		if (!this.readData || this.closed) return;
		try {
			const next = this.readData();
			this.refreshError = null;
			const currentSignature = JSON.stringify([this.data.rootId, this.data.nodes.map((node) => [node.nodeId, node.parentId, node.childIds, node.status, node.task, node.version, node.updatedAt])]);
			const nextSignature = JSON.stringify([next.rootId, next.nodes.map((node) => [node.nodeId, node.parentId, node.childIds, node.status, node.task, node.version, node.updatedAt])]);
			if (currentSignature !== nextSignature) this.setData(next);
		} catch (error) {
			// Keep the last complete snapshot visible, but surface refresh failures
			// in the details pane instead of silently hiding them.
			this.refreshError = error instanceof Error ? error.message : String(error);
		}
	}

	private readLiveOutput(node: SwarmTreeNode) {
		try {
			this.outputError = null;
			return this.readOutput!(node) ?? "No tmux output available for this node.";
		} catch (error) {
			this.outputError = error instanceof Error ? error.message : String(error);
			return "Live output unavailable.";
		}
	}
}
