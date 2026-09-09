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
