import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { makeNode } from "./runtime.ts";
import { SwarmTree } from "./tree-ui.ts";

const theme: Pick<Theme, "fg"> = { fg: (_color, text) => text };

test("tree details expose mocked worker isolation, branch, and process containment state", () => {
	const root = makeNode("run_test", "node_root", "coordinator", "Coordinate", "/repo", null);
	const worker = makeNode("run_test", "node_worker", "worker", "Implement", "/repo/worker", root.nodeId);
	root.childIds = [worker.nodeId];
	worker.branch = "pi-swarm/run_test/node_worker";
	worker.tmuxSession = "pi-swarm-run_test";
	worker.tmuxWindow = "node_worker";
	worker.sandbox = {
		backend: "macos-sandbox-exec", profile: "/state/worker.sb", readOnlyWorktree: false,
		network: "tcp-udp-outbound", lifecycle: "process-group",
	};
	const tree = new SwarmTree(theme, () => [root, worker], () => "worker output", () => {});
	tree.handleInput("j");
	const rendered = tree.render(120).join("\n");
	expect(rendered).toContain("macos-sandbox-exec");
	expect(rendered).toContain("process groups only");
	expect(rendered).toContain("pi-swarm/run_test/node_worker");
	expect(rendered).toContain("worker output");
});
