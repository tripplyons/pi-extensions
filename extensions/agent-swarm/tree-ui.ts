import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { NodeRecord, NodeStatus } from "./types.ts";
import { formatWorkerOutput, sanitizeTerminalText } from "./output-format.ts";

const plain = (text: string) => sanitizeTerminalText(text).replace(/[\r\n\t]/g, " ");

const hiddenStatuses = new Set<NodeStatus>(["completed", "stopped"]);

const treeRows = (allNodes: NodeRecord[], hideTerminal = false) => {
	const visible = (node: NodeRecord) => !hideTerminal || node.parentId === null || node.role === "coordinator" || !hiddenStatuses.has(node.status);
	const nodes = allNodes.filter(visible);
	const byId = new Map(nodes.map((node) => [node.nodeId, node]));
	const allById = new Map(allNodes.map((node) => [node.nodeId, node]));
	const visibleParent = (node: NodeRecord): string | null => {
		let parentId = node.parentId;
		const seen = new Set<string>();
		while (parentId && !seen.has(parentId)) {
			seen.add(parentId);
			const parent = allById.get(parentId);
			if (!parent) return null;
			if (visible(parent)) return parent.nodeId;
			parentId = parent.parentId;
		}
		return null;
	};
	const visited = new Set<string>();
	const rows: { node: NodeRecord; prefix: string }[] = [];
	const compare = (left: NodeRecord, right: NodeRecord) => left.createdAt - right.createdAt || left.nodeId.localeCompare(right.nodeId);
	const children = (parent: NodeRecord) => {
		const declared = parent.childIds.map((id) => byId.get(id)).filter((node): node is NodeRecord => node !== undefined && visibleParent(node) === parent.nodeId);
		const declaredIds = new Set(declared.map((node) => node.nodeId));
		const unlisted = nodes.filter((node) => visibleParent(node) === parent.nodeId && !declaredIds.has(node.nodeId)).sort(compare);
		return [...declared, ...unlisted];
	};
	const visit = (node: NodeRecord, guides = "", connector = "") => {
		if (visited.has(node.nodeId)) return;
		visited.add(node.nodeId);
		rows.push({ node, prefix: guides + connector });
		const descendants = children(node);
		const nextGuides = guides + (connector === "├─ " ? "│  " : connector === "└─ " ? "   " : "");
		descendants.forEach((child, index) => visit(child, nextGuides, index === descendants.length - 1 ? "└─ " : "├─ "));
	};
	const roots = nodes.filter((node) => visibleParent(node) === null).sort((left, right) => Number(right.role === "coordinator") - Number(left.role === "coordinator") || compare(left, right));
	for (const root of roots) visit(root);
	for (const orphan of nodes.filter((node) => !visited.has(node.nodeId)).sort(compare)) visit(orphan);
	return rows;
};

const statusColor = (status: NodeStatus): ThemeColor => {
	if (status === "running" || status === "completed") return "success";
	if (status === "starting" || status === "awaiting-review" || status === "rework") return "warning";
	if (status === "failed" || status === "rejected") return "error";
	return "dim";
};

export class SwarmTree {
	private selected = 0;
	private offset = 0;
	private hideTerminal = true;
	private followOutput = true;
	private selectedNodeId?: string;
	constructor(private theme: Pick<Theme, "fg">, private nodes: () => NodeRecord[], private output: (node: NodeRecord) => string, private close: () => void, private backlog: (node: NodeRecord) => number = () => 0) {}
	invalidate() {}
	handleInput(data: string) {
		if (data === "q" || matchesKey(data, "escape")) this.close();
		if (data === "j" || matchesKey(data, "down")) { this.selected++; this.offset = 0; this.followOutput = true; }
		if (data === "k" || matchesKey(data, "up")) { this.selected--; this.offset = 0; this.followOutput = true; }
		if (data === "]") this.offset++;
		if (data === "[") { this.offset = Math.max(0, this.offset - 1); this.followOutput = false; }
		if (data === " ") { this.hideTerminal = !this.hideTerminal; this.offset = 0; }
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const rows = treeRows(this.nodes(), this.hideTerminal);
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		const node = rows[this.selected]?.node;
		if (node?.nodeId !== this.selectedNodeId) {
			this.selectedNodeId = node?.nodeId;
			this.offset = 0;
			this.followOutput = true;
		}
		const tree = rows.map((row, index) => {
			const selected = index === this.selected;
			const marker = selected ? this.theme.fg("accent", ">") : " ";
			const role = this.theme.fg(selected ? "accent" : "muted", row.node.role);
			return `${marker} ${this.theme.fg("dim", row.prefix)}${role} ${this.theme.fg("dim", row.node.nodeId.slice(-8))} ${this.theme.fg(statusColor(row.node.status), row.node.status)}`;
		});
		const detail = (label: string, value: string, color: ThemeColor = "muted") => `${this.theme.fg("dim", `${label}:`)} ${this.theme.fg(color, plain(value))}`;
		const allDetails = node ? [
			`${this.theme.fg("accent", node.role)} ${this.theme.fg("dim", node.nodeId)}`,
			detail("Parent", node.parentId ?? "none"), detail("Task", node.task),
			detail("Sandbox", node.sandbox?.backend ?? "root session"), detail("Files", "unrestricted reads; denylist writes"), detail("Network", "outbound TCP/UDP; worker holds inference credentials"),
			detail("Lifecycle", "original process groups only; detached descendants may survive"),
			detail("Deadline", node.deadlineAt ? node.pausedAt !== null ? `paused; ${Math.max(0, Math.ceil((node.deadlineAt - node.pausedAt) / 1000))}s remaining` : new Date(node.deadlineAt).toISOString() : "none"),
			...(node.status === "awaiting-review" ? [detail("Submission", node.result?.settledAt === null ? "finishing turn; execution timeout active" : "paused for review")] : []),
			detail("Activity", `${Math.max(0, Math.floor((Date.now() - node.updatedAt) / 1000))}s ago`),
			detail("Pending requests", String(this.backlog(node))),
			detail("Branch", node.branch ?? "none"), detail("Result", node.result?.commit ?? "none", node.result?.commit ? "success" : "dim"),
			detail("Review", node.review?.action ?? "none", node.review?.action === "accept" ? "success" : node.review?.action === "reject" ? "error" : node.review?.action === "request-changes" ? "warning" : "dim"),
			detail("Integration", node.integrationCommit ?? "none", node.integrationCommit ? "success" : "dim"),
			detail("Cleanup", node.cleanedAt ? "removed" : "retained"), detail("Failure", node.failure ?? "none", node.failure ? "error" : "dim"), "",
			...formatWorkerOutput(this.output(node)).split("\n").map((line) => this.theme.fg("toolOutput", plain(line))),
		] : [this.theme.fg("dim", "No nodes")];
		const maxOffset = Math.max(0, allDetails.length - 24);
		if (this.followOutput) this.offset = maxOffset;
		else {
			this.offset = Math.min(this.offset, maxOffset);
			if (this.offset === maxOffset) this.followOutput = true;
		}
		const details = allDetails.slice(this.offset, this.offset + 24);
		const lines = width < 80 ? [...tree.slice(Math.max(0, this.selected - 4), this.selected + 5), "", ...details] : (() => {
			const leftWidth = Math.floor(width * 0.4);
			return Array.from({ length: Math.max(tree.length, details.length) }, (_, index) => {
				const left = truncateToWidth(tree[index] ?? "", leftWidth);
				return `${left}${" ".repeat(leftWidth - visibleWidth(left))} ${this.theme.fg("dim", "│")} ${truncateToWidth(details[index] ?? "", width - leftWidth - 3)}`;
			});
		})();
		return [...lines, this.theme.fg("dim", `↑↓ / j k select · space ${this.hideTerminal ? "show" : "hide"} completed/stopped · [ ] scroll details · q / esc close`)].map((line) => truncateToWidth(line, width));
	}
}
