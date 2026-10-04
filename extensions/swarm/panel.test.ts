import { expect, test } from "bun:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { elapsed, panel } from "./panel.ts";
import type { Node, Run } from "./state.ts";
import type { Health } from "./coordination.ts";
const start = "2026-01-01T00:00:00Z", now = Date.parse("2026-01-01T00:02:00Z");
const node = (id: string, parent: string | undefined, depth: number, status: Node["status"], extra: Partial<Node> = {}): Node =>
  ({ id, parent, name: id, task: `Task for ${id}`, depth, status, started: start,
    runtime: { revision: "a".repeat(40), loaded: start },
    permission: { status: "released", reason: "Task", source: "parent", updated: start },
    activity: { status: "tool-active", detail: "Tool boundary: read", updated: start, source: "tool-boundary" }, ...extra });
function fixture(extra: Partial<Node> = {}): Run {
  return { version: 1, id: "run", root: "root", objective: "Ship it", messages: [
    { id: "m1", from: "worker", to: "root", kind: "message", text: "First report", created: start, read: true },
    { id: "m2", from: "worker", to: "root", kind: "message", text: "Tests pass.\nChecking the diff.", created: start, read: false },
    { id: "m3", from: "root", to: "worker", kind: "instruction", text: "Do not show the incoming instruction", created: start, read: false },
  ], nodes: { root: node("root", undefined, 0, "running"), worker: node("worker", "root", 1, "running", extra) } };
}
const plain = (_color: string, text: string) => text;
const row = (run: Run, snapshots: Health[] = []) => panel(run, "root", new Set(["worker"]), 300, plain, now, snapshots)[1];

test("healthy rows show only name, age, and the latest worker message", () => {
  const run = fixture({ current: { model: "openai/sol", thinking: "max" }, result: "Previous slice",
    handoff: { revision: 1, status: "accepted" },
    delivery: [{ revision: "b".repeat(40), tested: { actor: "root", text: "Passed", recorded: start } }] });
  expect(row(run)).toBe("  worker  2m  Tests pass. Checking the diff.");
  run.nodes.worker.activity!.status = "working";
  expect(row(run)).toBe("  worker  2m  Tests pass. Checking the diff.");
  expect(run.nodes.worker.handoff?.status).toBe("accepted");
});

test("panel lists active workers as a tree and counts terminal ones", () => {
  const run = fixture();
  run.nodes.helper = node("helper", "worker", 2, "review", { result: "Ready for review", handoff: { revision: 1, status: "awaiting-parent", submitted: start } });
  run.nodes.done = node("done", "root", 1, "accepted");
  expect(panel(run, "root", new Set(["worker", "helper"]), 200, plain, now)).toEqual([
    "swarm · 2 active (1 awaiting-parent) · 1 terminal · Ship it",
    "  worker    2m  Tests pass. Checking the diff.",
    "    helper  2m  await-parent 2m  Ready for review",
  ]);
  expect(panel(run, "worker", new Set(["helper"]), 200, plain, now)[1]).toBe("  helper  2m  await-parent 2m  Ready for review");
  expect(panel(run, "helper", new Set(), 200, plain, now)).toEqual([
    "swarm · 0 active (0 awaiting-parent) · 0 terminal · Ship it", "  No active workers",
  ]);
});

test("check-ins, instructions, and waits show their status without duplicate holds", () => {
  for (const status of ["checking-in", "instruction-queued", "instruction-delivered", "waiting-instructions", "waiting-dependency"] as const) {
    const run = fixture({ activity: { status, detail: "Status report", updated: "2026-01-01T00:01:40Z", source: status.startsWith("instruction") ? "instruction" : "worker" } });
    if (status === "waiting-instructions") run.nodes.worker.permission!.status = "waiting-approval";
    if (status === "waiting-dependency") run.nodes.worker.permission!.status = "waiting-dependency";
    expect(row(run)).toContain(`${status} 20s ago`);
    expect(row(run)).toContain("Tests pass. Checking the diff.");
    expect(row(run).split(status)).toHaveLength(2);
    if (status === "waiting-instructions") expect(row(run)).not.toContain("waiting-approval");
  }
  const run = fixture({ activity: { status: "checking-in", detail: "Still held", updated: start } });
  run.nodes.worker.permission!.status = "checkpoint-hold";
  expect(row(run)).toContain("checkpoint-hold");
  expect(row(run)).toContain("checking-in");
});

test("starting and unknown activity remain visible", () => {
  expect(row(fixture({ status: "starting" }))).toContain("starting");
  expect(row(fixture({ activity: undefined }))).toContain("activity unknown");
  expect(row(fixture({ permission: undefined }))).toContain("permission unknown");
});

test("handoff previews flag overdue and recorded integration without showing routine code counts", () => {
  const run = fixture({ status: "review", result: "Done.\nAll checks pass.",
    permission: { status: "waiting-approval", reason: "Review", source: "worker", updated: start },
    handoff: { revision: 1, status: "awaiting-parent", submitted: "2025-12-31T23:55:00Z" },
    delivery: [{ revision: "b".repeat(40), integrated: { actor: "root", text: "Cherry-picked", recorded: start } }] });
  expect(row(run)).toBe("  worker  2m  await-parent 7m  review overdue  integrated; undecided  Done. All checks pass.");
  delete run.nodes.worker.handoff!.submitted;
  expect(row(run)).toContain("await-parent ?");
  expect(row(run)).not.toContain("review overdue");
});

test("missing panes, runtime mismatches, quiet workers, and health errors remain visible", () => {
  const run = fixture();
  expect(panel(run, "root", new Set(), 300, plain, now)[1]).toContain("no pane");
  run.nodes.worker.runtime!.revision = "b".repeat(40);
  expect(row(run)).toContain("version differs:bbbbbbbb");
  delete run.nodes.worker.runtime;
  expect(row(run)).toContain("version unknown");
  for (const state of ["quiet-with-job", "quiet-no-job"] as const) {
    const snapshot: Health = { nodeId: "worker", process: "present", state, quietSeconds: 600,
      jobs: [{ id: "job", source: "bash", status: "running" }, { id: "done", source: "bash", status: "succeeded" }] };
    expect(row(fixture(), [snapshot])).toContain(`${state} (1 live jobs)`);
  }
  const snapshot: Health = { nodeId: "worker", process: "present", state: "unknown", quietSeconds: null, jobs: [], error: "Cannot read jobs" };
  expect(row(fixture(), [snapshot])).toContain("health error");
});

test("message previews survive tool activity and use reports or an explicit empty state", () => {
  const run = fixture();
  run.messages = [];
  expect(row(run)).toBe("  worker  2m  No messages yet");
  run.nodes.worker.activity = { status: "working", detail: "Checking\nspacing", updated: start, source: "worker" };
  expect(row(run)).toBe("  worker  2m  Checking spacing");
  run.nodes.worker.activity = { status: "instruction-delivered", detail: "Incoming task", updated: start, source: "instruction" };
  expect(row(run)).toContain("No messages yet");
  run.messages.push({ id: "sibling", from: "worker", to: "helper", kind: "message", text: "API agreed", created: start, read: true });
  expect(row(run)).toContain("API agreed");
});

test("narrow and wide-character rows fit the available width and leave room for the message", () => {
  const run = fixture({ name: "界".repeat(20) });
  run.messages[1].text = "Latest report with a long message";
  const paint = (color: string, text: string) => `\x1b[${color === "dim" ? 90 : 33}m${text}\x1b[0m`;
  for (const width of [1, 10, 30, 40, 80, 200]) {
    for (const line of panel(run, "root", new Set(["worker"]), width, paint, now)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
  expect(panel(run, "root", new Set(["worker"]), 40, plain, now)[1]).toContain("Latest report");
  const small = panel(run, "root", new Set(["worker"]), 40, plain, now)[1];
  const large = panel(run, "root", new Set(["worker"]), 80, plain, now)[1];
  expect(large).not.toBe(truncateToWidth(small, 80));
  expect(large).toContain(run.messages[1].text);
});

test("elapsed time is compact and missing or invalid times stay unknown", () => {
  expect(elapsed(undefined, 0)).toBe("");
  expect(elapsed("invalid", 0)).toBe("");
  expect(elapsed("1970-01-01T00:00:00Z", 59_000)).toBe("59s");
  expect(elapsed("1970-01-01T00:00:00Z", 125_000)).toBe("2m");
  expect(elapsed("1970-01-01T00:00:00Z", 7_260_000)).toBe("2h1m");
  expect(row(fixture({ started: undefined }))).toContain("worker  ?");
});
