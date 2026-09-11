import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mixturePreview, renderMixtureCall, renderMixtureResult } from "./tool-render.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
test("calls and pending acknowledgements are readable without claiming completion", () => {
	expect(renderMixtureCall("mixture_process", { action: "stop", runId: "mix_test", workerId: "slot-0" }, theme).render(100).join("\n").trim()).toBe("mixture stop mix_test · slot-0");
	const result = { details: { preview: mixturePreview({ runId: "mix_test", requestId: "cmd_test", status: "pending" }) } };
	expect(renderMixtureResult(result, { expanded: false }, theme).render(100).join("\n")).toContain("pending · request cmd_test");
});

test("worker previews wrap, expand and strip terminal commands", () => {
	const preview = mixturePreview({ id: "mix_test", workers: Array.from({ length: 3 }, (_, i) => ({ id: `slot-${i}`, model: "model", attempts: [{ attempt: 1, status: "ok", output: "\x1b[2J391 " + "界".repeat(200), usage: { turns: 1, input: 5, output: 2, cost: 0.001 } }] })) });
	const result = { details: { preview, stateFile: "/state/run.json" } };
	const collapsed = renderMixtureResult(result, { expanded: false }, theme).render(40);
	const expanded = renderMixtureResult(result, { expanded: true }, theme).render(40);
	expect(collapsed.join("\n")).toContain("expand for details");
	expect(expanded.join("\n")).toContain("Full state: /state/run.json");
	expect(expanded.join("\n")).not.toContain("\x1b");
	for (const line of [...collapsed, ...expanded]) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
});

test("restored completion JSON, empty lists and errors have text previews", () => {
	expect(renderMixtureResult({ content: JSON.stringify({ runId: "mix_test", workerId: "slot-0", model: "glm", status: "ok", output: "391" }) }, { expanded: false }, theme).render(100).join("\n")).toContain("slot-0 · glm · ok");
	expect(renderMixtureResult({ content: "[]" }, { expanded: false }, theme).render(100).join("\n").trim()).toBe("No mixture runs");
	expect(renderMixtureResult({ content: "runId is required", isError: true }, { expanded: false }, theme).render(100).join("\n").trim()).toBe("runId is required");
});
