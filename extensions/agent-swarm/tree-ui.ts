import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { NodeRecord } from "./types.ts";

const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

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
		const nodes = this.nodes();
		this.selected = Math.max(0, Math.min(this.selected, nodes.length - 1));
		const node = nodes[this.selected];
		const tree = nodes.map((item, index) => {
			let depth = 0;
			let parent = item.parentId;
			const seen = new Set([item.nodeId]);
			while (parent && !seen.has(parent)) { seen.add(parent); depth++; parent = nodes.find((entry) => entry.nodeId === parent)?.parentId ?? null; }
			return `${index === this.selected ? ">" : " "} ${"  ".repeat(depth)}${item.role} ${item.nodeId.slice(-8)} ${item.status}`;
		});
		const details = node ? [
			`${node.role} ${node.nodeId}`, `Parent: ${node.parentId ?? "none"}`, `Task: ${plain(node.task)}`,
			`Sandbox: ${node.sandbox?.backend ?? "root session"}`, "Network: outbound TCP/UDP; worker holds inference credentials",
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
