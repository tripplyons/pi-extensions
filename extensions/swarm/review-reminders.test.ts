import { expect, test } from "bun:test";
import { reviews } from "./coordination.ts";
import { ReviewReminders, reviewPrompt } from "./review-reminders.ts";
import { coordinationGuidelines, treeSnapshot } from "./prompts.ts";
import { panel } from "./panel.ts";
import type { Node, Run } from "./state.ts";

const start = Date.parse("2026-01-01T00:00:00Z");
function fixture(count = 1) {
  const root: Node = { id: "root", name: "Root", task: "Objective", depth: 0, status: "running" };
  const run: Run = { version: 1, id: "run", root: root.id, objective: root.task, nodes: { root }, messages: [] };
  for (let i = count; i > 0; i--) {
    const id = `worker-${i}`;
    run.nodes[id] = { id, parent: root.id, name: id, task: "Task", depth: 1, status: "review", result: "Handoff",
      handoff: { revision: 1, status: "awaiting-parent", submitted: new Date(start + i * 1000).toISOString() } };
  }
  return run;
}

test("reminders steer once per five minutes and stop after explicit decisions", () => {
  const run = fixture(), reminders = new ReviewReminders();
  expect(reminders.next(run, "root", start + 300_999)).toBeUndefined();
  expect(reminders.snapshot(run, "root", start + 300_999)).toMatchObject({ state: "scheduled", scheduledAt: new Date(start + 301_000).toISOString() });
  expect(reminders.next(run, "root", start + 301_000)).toContain("worker-1");
  expect(reminders.snapshot(run, "root", start + 301_000)).toMatchObject({ state: "queued", queuedAt: new Date(start + 301_000).toISOString() });
  expect(reminders.next(run, "root", start + 900_000)).toBeUndefined();
  expect(reminders.delivered("run", "root", new Date(start + 301_000).toISOString(), start + 301_000)).toBe(true);
  expect(reminders.snapshot(run, "root", start + 301_000)).toMatchObject({ state: "delivered", deliveredAt: new Date(start + 301_000).toISOString(), scheduledAt: new Date(start + 601_000).toISOString() });
  expect(reminders.next(run, "root", start + 600_999)).toBeUndefined();
  expect(reminders.next(run, "root", start + 601_000)).toContain("overdue");
  reminders.delivered("run", "root", new Date(start + 601_000).toISOString(), start + 601_000);
  for (const status of ["accepted", "rejected", "running", "stopped"] as const) {
    run.nodes["worker-1"].status = status;
    expect(reminders.next(run, "root", start + 901_000)).toBeUndefined();
  }
  run.nodes["worker-1"].status = "review";
  run.nodes["worker-1"].handoff = { revision: 2, status: "awaiting-parent", submitted: new Date(start + 901_000).toISOString() };
  expect(reminders.next(run, "root", start + 901_000)).toBeUndefined();
  expect(reminders.next(run, "root", start + 1_201_000)).toContain("revision 2");
});

test("queued reminders survive a long delivery wait and cadence starts at matching delivery", () => {
  const run = fixture(), reminders = new ReviewReminders();
  const queued = start + 301_000, delivered = start + 1_501_000;
  expect(reminders.next(run, "root", queued)).toContain("worker-1");
  expect(reminders.next(run, "root", delivered)).toBeUndefined();
  expect(reminders.delivered("other-run", "root", new Date(queued).toISOString(), delivered)).toBe(false);
  expect(reminders.delivered("run", "other-owner", new Date(queued).toISOString(), delivered)).toBe(false);
  expect(reminders.delivered("run", "root", new Date(queued + 1).toISOString(), delivered)).toBe(false);
  expect(reminders.snapshot(run, "root", delivered).state).toBe("queued");
  expect(reminders.delivered("run", "root", new Date(queued).toISOString(), delivered)).toBe(true);
  expect(reminders.delivered("run", "root", new Date(queued).toISOString(), delivered + 1000)).toBe(false);
  expect(reminders.next(run, "root", delivered + 299_999)).toBeUndefined();
  expect(reminders.next(run, "root", delivered + 300_000)).toContain("worker-1");
  reminders.reset();
  expect(reminders.delivered("run", "root", new Date(delivered + 300_000).toISOString())).toBe(false);
});

test("aggregate prompts are bounded, oldest first and restricted to direct children", () => {
  const run = fixture(5), reminders = new ReviewReminders();
  run.nodes.nested = { ...run.nodes["worker-1"], id: "nested", parent: "worker-1", name: "Nested" };
  const text = reminders.next(run, "root", start + 900_000)!;
  expect(text.indexOf("worker-1")).toBeLessThan(text.indexOf("worker-2"));
  expect(text.indexOf("worker-2")).toBeLessThan(text.indexOf("worker-3"));
  expect(text).not.toContain("worker-4"); expect(text).not.toContain("worker-5"); expect(text).not.toContain("Nested");
  expect(text).toContain("2 more"); expect(text).toContain("(5)");
  const newcomer = { ...run.nodes["worker-1"], id: "new", name: "New" };
  run.nodes.new = newcomer;
  expect(reminders.next(run, "root", start + 900_001)).toBeUndefined();
  expect(reviewPrompt(reviews(run, "root", start + 900_000))).toContain("3 more");
  reminders.delivered("run", "root", new Date(start + 900_000).toISOString(), start + 900_000);
  expect(reminders.next(run, "root", start + 1_200_000)).toContain("3 more");
  expect(coordinationGuidelines(run.nodes.root, run).join("\n")).toContain("3 more");
  expect(reminders.next(run, "worker-1", start + 900_000)).toContain("Nested");
  expect(reminders.next(run, "root", start + 900_000)).toContain("Pending direct-child");
});

test("legacy unknown ages get local reminders without invented submission times", () => {
  const run = fixture(), worker = run.nodes["worker-1"], reminders = new ReviewReminders();
  delete worker.handoff;
  expect(reviews(run, "root", start)[0]).toMatchObject({ waitingSeconds: null, overdue: false });
  expect(reminders.next(run, "root", start)).toBeUndefined();
  expect(reminders.next(run, "root", start + 300_000)).toContain("waiting unknown seconds");
  reminders.delivered("run", "root", new Date(start + 300_000).toISOString(), start + 300_000);
  expect(reminders.next(run, "root", start + 599_999)).toBeUndefined();
  expect(reminders.next(run, "root", start + 600_000)).toContain("unknown");
  reminders.reset();
  expect(reminders.next(run, "root", start + 600_001)).toBeUndefined();
  worker.handoff = { revision: 1, status: "awaiting-parent", submitted: "invalid" };
  expect(reviews(run, "root", start)[0].waitingSeconds).toBeNull();
  run.messages.push({ id: "m", from: worker.id, to: "root", kind: "message", text: "Awaiting parent review: legacy", read: true, created: new Date(start).toISOString() });
  delete worker.handoff;
  expect(reviews(run, "root", start + 300_000)[0]).toMatchObject({ waitingSeconds: 300, overdue: true });
});

test("recorded integration flags undecided handoffs without deciding or inferring other evidence", () => {
  const run = fixture(), worker = run.nodes["worker-1"];
  worker.delivery = [{ revision: "a".repeat(40), integrated: { actor: "root", recorded: new Date(start).toISOString(), text: "Cherry-picked" } }];
  const before = structuredClone(run), now = start + 901_000;
  expect(reviews(run, "root", now)[0]).toMatchObject({ overdue: true, integratedRevisions: ["a".repeat(40)] });
  expect(new ReviewReminders().next(run, "root", now)).toContain("code integration recorded, handoff undecided");
  expect(treeSnapshot(run, false, undefined, now).nodes[1]).toMatchObject({ handoff: "awaiting-parent", code: { records: [{ reviewed: false, tested: false, integrated: true }] } });
  const row = panel(run, "root", new Set([worker.id]), 300, (_, text) => text, now)[1];
  expect(row).toContain("review overdue"); expect(row).toContain("integrated; undecided");
  expect(run).toEqual(before);
  worker.status = "accepted";
  expect(reviews(run, "root", now)).toEqual([]);
});
