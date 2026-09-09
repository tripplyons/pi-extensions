import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { NodeRecord } from "./types.ts";

const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

const treeRows = (nodes: NodeRecord[]) => {
	const byId = new Map(nodes.map((node) => [node.nodeId, node]));
	const visited = new Set<string>();
	const rows: { node: NodeRecord; prefix: string }[] = [];
	const compare = (left: NodeRecord, right: NodeRecord) => left.createdAt - right.createdAt || left.nodeId.localeCompare(right.nodeId);
	const children = (parent: NodeRecord) => {
		const declared = parent.childIds.map((id) => byId.get(id)).filter((node): node is NodeRecord => node?.parentId === parent.nodeId);
		const declaredIds = new Set(declared.map((node) => node.nodeId));
		const unlisted = nodes.filter((node) => node.parentId === parent.nodeId && !declaredIds.has(node.nodeId)).sort(compare);
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
	const roots = nodes.filter((node) => node.parentId === null).sort((left, right) => Number(right.role === "coordinator") - Number(left.role === "coordinator") || compare(left, right));
	for (const root of roots) visit(root);
	for (const orphan of nodes.filter((node) => !visited.has(node.nodeId)).sort(compare)) visit(orphan);
	return rows;
};

export class SwarmTree {
	private selected = 0;
	private offset = 0;
	constructor(private nodes: () => NodeRecord[], private output: (node: NodeRecord) => string, private close: () => void, private backlog: (node: NodeRecord) => number = () => 0) {}
	invalidate() {}
	handleInput(data: string) {
		if (data === "q" || matchesKey(data, "escape")) this.close();
		if (data === "j" || matchesKey(data, "down")) { this.selected++; this.offset = 0; }
		if (data === "k" || matchesKey(data, "up")) { this.selected--; this.offset = 0; }
		if (data === "]") this.offset++;
		if (data === "[") this.offset = Math.max(0, this.offset - 1);
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const rows = treeRows(this.nodes());
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		const node = rows[this.selected]?.node;
		const tree = rows.map((row, index) => `${index === this.selected ? ">" : " "} ${row.prefix}${row.node.role} ${row.node.nodeId.slice(-8)} ${row.node.status}`);
		const details = node ? [
			`${node.role} ${node.nodeId}`, `Parent: ${node.parentId ?? "none"}`, `Task: ${plain(node.task)}`,
			`Sandbox: ${node.sandbox?.backend ?? "root session"}`, "Files: unrestricted reads; denylist writes", "Network: outbound TCP/UDP; worker holds inference credentials",
			"Lifecycle: original process groups only; detached descendants may survive",
			`Deadline: ${node.deadlineAt ? new Date(node.deadlineAt).toISOString() : "none"}`,
			`Activity: ${Math.max(0, Math.floor((Date.now() - node.updatedAt) / 1000))}s ago`,
			`Pending requests: ${this.backlog(node)}`,
			`Branch: ${node.branch ?? "none"}`, `Result: ${node.result?.commit ?? "none"}`,
			`Review: ${node.review?.action ?? "none"}`, `Integration: ${node.integrationCommit ?? "none"}`,
			`Cleanup: ${node.cleanedAt ? "removed" : "retained"}`, `Failure: ${node.failure ?? "none"}`, "",
			...this.output(node).split("\n").map(plain),
		].slice(this.offset, this.offset + 24) : ["No nodes"];
		const lines = width < 80 ? [...tree.slice(Math.max(0, this.selected - 4), this.selected + 5), "", ...details] : (() => {
			const leftWidth = Math.floor(width * 0.4);
			return Array.from({ length: Math.max(tree.length, details.length) }, (_, index) => {
				const left = truncateToWidth(plain(tree[index] ?? ""), leftWidth);
				return `${left}${" ".repeat(leftWidth - visibleWidth(left))} │ ${truncateToWidth(plain(details[index] ?? ""), width - leftWidth - 3)}`;
			});
		})();
		return [...lines, "↑↓ / j k select · [ ] scroll details · q / esc close"].map((line) => truncateToWidth(line, width));
	}
}
