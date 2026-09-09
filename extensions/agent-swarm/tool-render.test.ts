import { expect, test } from "bun:test";
import { renderSwarmCall, renderSwarmResult } from "./tool-render.ts";

const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `**${text}**` } as any;
const draw = (component: any, width = 300) => component.render(width).join("\n");

test("renders partial calls as compact semantic previews", () => {
	expect(draw(renderSwarmCall("swarm_spawn", { role: "worker", task: "Investigate\nrendering behavior" }, theme))).toContain("<toolTitle>**swarm spawn**</toolTitle> <accent>worker</accent> · <dim>task:</dim> <muted>Investigate rendering behavior</muted>");
	expect(draw(renderSwarmCall("swarm_send", { nodeId: "node_1234567890abcdef", body: "hello" }, theme), 30)).not.toContain("[object Object]");
	const options = draw(renderSwarmCall("swarm_spawn", { reviewTargetId: "node_1234567890abcdef", includeDirty: true, full: false, acknowledge: ["one", "two"] }, theme));
	expect(options).toContain("<dim>ack:</dim> <muted>2 messages</muted>");
	expect(options).toContain("<dim>review:</dim> <accent>90abcdef</accent>");
	expect(options).toContain("<dim>dirty files:</dim> <warning>included</warning>");
	expect(options).toContain("<dim>output:</dim> <muted>summary</muted>");
});

test("renders tree results with roles, statuses, hierarchy, messages, and commits", () => {
	const payload = { status: "active", nodes: [
		{ nodeId: "node_aaaaaaaa11111111", parentId: null, role: "coordinator", status: "running", task: "Lead" },
		{ nodeId: "node_bbbbbbbb22222222", parentId: "node_aaaaaaaa11111111", role: "worker", status: "completed", task: "Implement", result: { commit: "abcdef1234567890" } },
	], messages: [{ fromNodeId: "node_bbbbbbbb22222222", toNodeId: "node_aaaaaaaa11111111", body: "Done" }] };
	const rendered = draw(renderSwarmResult("swarm_tree", { content: [{ type: "text", text: JSON.stringify(payload) }] }, theme));
	expect(rendered).toContain("<success>active</success>");
	expect(rendered).toContain("└─ ");
	expect(rendered).toContain("<dim>commit:</dim> <success>abcdef123456</success>");
	expect(rendered).toContain("<muted>Done</muted>");
});

test("renders malformed and error results safely", () => {
	expect(draw(renderSwarmResult("swarm_review", { content: [{ type: "text", text: "controller exploded" }] }, theme))).toContain("<error>controller exploded</error>");
	expect(draw(renderSwarmResult("swarm_review", { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "stale version" }) }] }, theme))).toContain("<error>error</error>");
	expect(draw(renderSwarmResult("swarm_task", { content: [{ type: "text", text: JSON.stringify({ changed: false }) }] }, theme))).toContain("<muted>no changes</muted>");
});

test("removes terminal escapes, controls, and invisible direction overrides", () => {
	const hostile = "safe\u001b]8;;https://evil.invalid\u0007link\u001b]8;;\u0007\u202eevil\u0000end";
	const call = draw(renderSwarmCall("swarm_send", { body: hostile }, theme));
	const error = draw(renderSwarmResult("swarm_send", { content: [{ type: "text", text: JSON.stringify({ ok: false, error: hostile }) }] }, theme));
	for (const rendered of [call, error]) {
		expect(rendered).not.toContain("\u001b");
		expect(rendered).not.toContain("\u202e");
		expect(rendered).not.toContain("\u0000");
		expect(rendered).not.toContain("evil.invalid");
	}
});
