import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { makeNode } from "./runtime.ts";
import { SwarmTree } from "./tree-ui.ts";

const colors = { accent: 36, muted: 2, dim: 90, success: 32, error: 31, warning: 33, toolOutput: 37 } as const;
const theme: Pick<Theme, "fg"> = { fg: (color: ThemeColor, text: string) => `\x1b[${colors[color as keyof typeof colors] ?? 0}m${text}\x1b[0m` };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("tree navigates live nodes and constrains terminal output at narrow widths", () => {
	const root = makeNode("run_test", "node_root", "coordinator", "Inspect 界".repeat(20), "/tmp", null);
	const child = makeNode("run_test", "node_child", "worker", "Implement", "/tmp/child", root.nodeId);
	let closed = false;
	const tree = new SwarmTree(theme, () => [root, child], () => "\x1b]52;clipboard\x07\noutput", () => { closed = true; });
	for (const width of [1, 20, 79, 80, 120]) {
		const lines = tree.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines.join("\n")).not.toContain("\x1b]");
		expect(lines.join("\n")).not.toContain("\x07");
	}
	tree.handleInput("j");
	expect(plain(tree.render(120).join("\n"))).toContain("worker node_child");
	child.failure = "Live failure";
	expect(plain(tree.render(120).join("\n"))).toContain("Live failure");
	tree.handleInput("q");
	expect(closed).toBe(true);
});

test("tree renders parents before their nested children", () => {
	const root = makeNode("run_test", "node_root", "coordinator", "Coordinate", "/tmp", null);
	const manager = makeNode("run_test", "node_manager", "manager", "Manage", "/tmp/manager", root.nodeId);
	const worker = makeNode("run_test", "node_worker", "worker", "Implement", "/tmp/worker", manager.nodeId);
	const sibling = makeNode("run_test", "node_sibling", "worker", "Check", "/tmp/sibling", root.nodeId);
	sibling.status = "failed";
	root.childIds = [manager.nodeId, sibling.nodeId];
	manager.childIds = [worker.nodeId];
	const tree = new SwarmTree(theme, () => [worker, sibling, manager, root], () => "", () => {});
	const styled = tree.render(79).join("\n");
	const rendered = plain(styled);
	const coordinatorAt = rendered.indexOf("coordinator ode_root");
	const managerAt = rendered.indexOf("├─ manager _manager");
	const workerAt = rendered.indexOf("│  └─ worker e_worker");
	const siblingAt = rendered.indexOf("└─ worker _sibling");
	expect(coordinatorAt).toBeGreaterThanOrEqual(0);
	expect(managerAt).toBeGreaterThan(coordinatorAt);
	expect(workerAt).toBeGreaterThan(managerAt);
	expect(siblingAt).toBeGreaterThan(workerAt);
	expect(styled).toContain("\x1b[36m>\x1b[0m");
	expect(styled).toContain("\x1b[2mmanager\x1b[0m");
	expect(styled).toContain("\x1b[32mrunning\x1b[0m");
	expect(styled).toContain("\x1b[33mstarting\x1b[0m");
	expect(styled).toContain("\x1b[31mfailed\x1b[0m");
});

test("space hides completed/stopped nodes, promotes descendants, and clamps selection", () => {
	const root = makeNode("run_test", "node_root", "coordinator", "Coordinate", "/tmp", null);
	const manager = makeNode("run_test", "node_manager", "manager", "Done managing", "/tmp/manager", root.nodeId);
	const worker = makeNode("run_test", "node_worker", "worker", "Still working", "/tmp/worker", manager.nodeId);
	const failed = makeNode("run_test", "node_failed", "worker", "Failed", "/tmp/failed", root.nodeId);
	const rejected = makeNode("run_test", "node_rejected", "worker", "Rejected", "/tmp/rejected", root.nodeId);
	const stopped = makeNode("run_test", "node_stopped", "worker", "Stopped", "/tmp/stopped", root.nodeId);
	root.childIds = [manager.nodeId, failed.nodeId, rejected.nodeId, stopped.nodeId];
	manager.childIds = [worker.nodeId];
	manager.status = "completed";
	failed.status = "failed";
	rejected.status = "rejected";
	stopped.status = "stopped";
	const tree = new SwarmTree(theme, () => [stopped, rejected, failed, worker, manager, root], () => "", () => {});

	for (let index = 0; index < 5; index++) tree.handleInput("j");
	expect(plain(tree.render(120).join("\n"))).toContain("worker node_stopped");
	tree.handleInput(" ");
	const hidden = plain(tree.render(120).join("\n"));
	expect(hidden).not.toContain("manager _manager completed");
	expect(hidden).not.toContain("node_stopped");
	expect(hidden).toContain("e_failed failed");
	expect(hidden).toContain("rejected rejected");
	expect(hidden).toContain("└─ worker e_worker");
	expect(hidden).toContain("space show completed/stopped");
	expect(hidden).toContain("Task: Still working");

	tree.handleInput(" ");
	const shown = plain(tree.render(120).join("\n"));
	expect(shown).toContain("manager _manager completed");
	expect(shown).toContain("worker _stopped stopped");
	expect(shown).toContain("space hide completed/stopped");
});

test("terminal coordinator remains visible when terminal nodes are hidden", () => {
	const root = makeNode("run_test", "node_root", "coordinator", "Done", "/tmp", null);
	root.status = "completed";
	const tree = new SwarmTree(theme, () => [root], () => "", () => {});
	tree.handleInput(" ");
	expect(plain(tree.render(80).join("\n"))).toContain("coordinator ode_root completed");
});

test("details auto-follow growth, pin on scroll, resume at bottom, and reset on selection", () => {
	const root = makeNode("run_test", "node_root", "coordinator", "Coordinate", "/tmp", null);
	const child = makeNode("run_test", "node_child", "worker", "Implement", "/tmp/child", root.nodeId);
	root.childIds = [child.nodeId];
	let rootLines = Array.from({ length: 30 }, (_, index) => `root-${index}`);
	const tree = new SwarmTree(theme, () => [root, child], (node) => node === root ? rootLines.join("\n") : Array.from({ length: 30 }, (_, index) => `child-${index}`).join("\n"), () => {});

	let rendered = plain(tree.render(79).join("\n"));
	expect(rendered).toContain("root-29");
	expect(rendered).not.toContain("root-0\n");
	rootLines.push("root-30");
	expect(plain(tree.render(79).join("\n"))).toContain("root-30");

	tree.handleInput("[");
	rendered = plain(tree.render(79).join("\n"));
	expect(rendered).not.toContain("root-30");
	rootLines.push("root-31");
	rendered = plain(tree.render(79).join("\n"));
	expect(rendered).not.toContain("root-31");

	tree.handleInput("]");
	tree.handleInput("]");
	rendered = plain(tree.render(79).join("\n"));
	expect(rendered).toContain("root-31");
	rootLines.push("root-32");
	expect(plain(tree.render(79).join("\n"))).toContain("root-32");

	tree.handleInput("j");
	rendered = plain(tree.render(120).join("\n"));
	expect(rendered).toContain("child-29");
	expect(rendered).not.toContain("child-0\n");
});
