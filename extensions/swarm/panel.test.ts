import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { elapsed, panel } from "./panel.ts";
import type { Node, Run } from "./state.ts";
const node = (id: string, parent: string | undefined, depth: number, status: Node["status"], extra: Partial<Node> = {}): Node =>
  ({ id, parent, name: id, task: `Task for ${id}`, depth, status, ...extra });
const run: Run = { version: 1, id: "run", root: "root", objective: "Ship it", messages: [
  { id: "m1", from: "root", to: "lead", kind: "instruction", text: "Go", created: "", read: false },
  { id: "m2", from: "root", to: "lead", kind: "message", text: "Old", created: "", read: true },
], nodes: {
  root: node("root", undefined, 0, "running"),
  lead: node("lead", "root", 1, "running", { started: "2026-01-01T00:00:00Z", launch: { model: "anthropic/opus", thinking: "high" } }),
  helper: node("helper", "lead", 2, "review", { task: "Line one\nline two" }),
  done: node("done", "root", 1, "accepted"),
} };
const paint = (color: string, text: string) => `<${color}>${text}`;
test("panel lists active workers as a tree and counts finished ones", () => {
  const now = Date.parse("2026-01-01T01:05:00Z");
  expect(panel(run, "root", new Set(["lead"]), 200, paint, now)).toEqual([
    "<accent>swarm<dim> · 2 active<dim> · 1 finished<dim> · <dim>Ship it",
    "  lead      <success>running   1h5m    <muted>anthropic/opus:high  <warning>1 unread  <dim>Task for lead",
    "    helper  <accent>review            <error>no pane  <dim>Line one line two",
  ]);
  expect(panel(run, "lead", new Set(), 200, paint, now).slice(1)).toEqual(["  helper  <accent>review            <error>no pane  <dim>Line one line two"]);
  expect(panel(run, "helper", new Set(), 200, paint, now)).toEqual(["<accent>swarm<dim> · 0 active<dim> · 0 finished<dim> · <dim>Ship it", "<dim>  No active workers"]);
  for (const line of panel(run, "root", new Set(), 30, (_, text) => text, now)) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
});
test("elapsed time is compact", () => {
  expect(elapsed(undefined, 0)).toBe("");
  expect(elapsed("1970-01-01T00:00:00Z", 59_000)).toBe("59s");
  expect(elapsed("1970-01-01T00:00:00Z", 125_000)).toBe("2m");
  expect(elapsed("1970-01-01T00:00:00Z", 7_260_000)).toBe("2h1m");
});
