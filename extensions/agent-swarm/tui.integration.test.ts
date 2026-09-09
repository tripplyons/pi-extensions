import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { makeNode } from "./runtime.ts";
import { SwarmTree } from "./tree-ui.ts";

test("tree navigates live nodes and constrains terminal output at narrow widths", () => {
	const root = makeNode("run_test", "node_root", "coordinator", "Inspect 界".repeat(20), "/tmp", null);
	const child = makeNode("run_test", "node_child", "worker", "Implement", "/tmp/child", root.nodeId);
	let closed = false;
	const tree = new SwarmTree(() => [root, child], () => "\x1b]52;clipboard\x07\noutput", () => { closed = true; });
	for (const width of [1, 20, 79, 80, 120]) {
		const lines = tree.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines.join("\n")).not.toContain("\x1b]");
		expect(lines.join("\n")).not.toContain("\x07");
	}
	tree.handleInput("j");
	expect(tree.render(120).join("\n")).toContain("worker node_child");
	child.failure = "Live failure";
	expect(tree.render(120).join("\n")).toContain("Live failure");
	tree.handleInput("q");
	expect(closed).toBe(true);
});
