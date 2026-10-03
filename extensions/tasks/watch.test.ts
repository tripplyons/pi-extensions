import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import { Tasks, registerTaskTools, taskKey, watchKey, watchWarnings, type Watch } from "./tasks.ts";

async function fixture(check: (h: ReturnType<typeof harness>, tasks: Tasks, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-task-watch-"));
  const tasks = new Tasks(root, { exec: async (_command, _cwd, { signal, onData }) => {
    onData(Buffer.from("progress €\n"));
    return new Promise(resolve => signal?.addEventListener("abort", () => resolve({ exitCode: 0 }), { once: true }));
  } }, 10);
  const h = harness(); h.ctx.cwd = root; h.ctx.isIdle = () => true;
  registerTaskTools(h.pi, tasks); await h.emit("session_start");
  try { await check(h, tasks, root); }
  finally { await h.emit("session_shutdown"); await tasks.shutdown(); await rm(root, { recursive: true, force: true }); }
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(check()).toBe(true);
}

test("progress includes original deadline and bounded output without consuming the output cursor", () => fixture(async (h, tasks) => {
  const reply = await h.call("bash", { command: "fake job", run_in_background: true, timeout: 60 });
  const id = reply.details.task_id;
  const progress = await tasks.progress(id, Date.parse(tasks.query(id).created_at) + 10_000);
  expect(progress).toMatchObject({ elapsed_seconds: 10, deadline_remaining_seconds: 50, output_bytes: 13, recent_output: "progress €\n" });
  expect((await tasks.output(id)).output).toBe("progress €\n");
  expect((await tasks.output(id)).output).toBe("");
}));

test("watch reports are opt-in, persistent, branch-owned and wake only once for a warning episode", () => fixture(async (h, tasks) => {
  const reply = await h.call("bash", { command: "fake job", run_in_background: true });
  const id = reply.details.task_id;
  expect(h.entries.some(entry => entry.customType === watchKey)).toBe(false);
  const watch = await h.call("task_watch", { task_id: id, interval_seconds: 1, expected_seconds: 1 });
  expect(watch.details.watch).toMatchObject({ enabled: true, interval_seconds: 1 });
  expect(h.entries.at(-1).customType).toBe(watchKey);
  await waitFor(() => h.sentMessages.length >= 1);
  expect(h.sentMessages[0].message).toMatchObject({ customType: "pi-task-progress", details: { warnings: ["expected duration exceeded"] } });
  expect(h.sentMessages[0].message.content).toContain("not a measured ETA");
  expect(h.sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  await waitFor(() => h.sentMessages.length >= 2);
  expect(h.sentMessages[1].options.triggerTurn).toBe(false);
  expect((await tasks.output(id)).output).toBe("progress €\n");
  await h.call("task_watch", { task_id: id, enabled: false });
  const count = h.sentMessages.length;
  await new Promise(resolve => setTimeout(resolve, 1200)); expect(h.sentMessages).toHaveLength(count);
  const branch = h.entries.splice(0);
  await h.emit("session_tree");
  await expect(h.call("task_watch", { task_id: id })).rejects.toThrow("not on this session branch");
  h.entries.push(...branch);
  await h.emit("session_tree");
  expect(h.entries.find(entry => entry.customType === taskKey).data).toBe(id);
}));

test("watch reports wait for idle and restored watches resume without changing deadlines", () => fixture(async (h, tasks) => {
  h.ctx.isIdle = () => false;
  const reply = await h.call("bash", { command: "fake job", run_in_background: true, timeout: 120 });
  const id = reply.details.task_id, deadline = tasks.query(id).deadline_at;
  await h.call("task_watch", { task_id: id, interval_seconds: 1, silence_seconds: 1 });
  await new Promise(resolve => setTimeout(resolve, 1200)); expect(h.sentMessages).toHaveLength(0);
  h.ctx.isIdle = () => true; await h.emit("session_tree");
  await waitFor(() => h.sentMessages.length > 0);
  expect(h.sentMessages[0].message.details.warnings).toContain("output silent");
  expect(tasks.query(id).deadline_at).toBe(deadline);
}));

test("expected-duration and silence warnings are independent and require configured thresholds", () => {
  const watch: Watch = { task_id: "task", enabled: true, interval_seconds: 300, expected_seconds: 600, silence_seconds: 60 };
  expect(watchWarnings({ elapsed_seconds: 599, output_silence_seconds: 59 }, watch)).toEqual([]);
  expect(watchWarnings({ elapsed_seconds: 600, output_silence_seconds: 59 }, watch)).toEqual(["expected duration exceeded"]);
  expect(watchWarnings({ elapsed_seconds: 600, output_silence_seconds: 60 }, watch)).toEqual(["expected duration exceeded", "output silent"]);
  expect(watchWarnings({ elapsed_seconds: 9999, output_silence_seconds: 9999 }, { task_id: "task", enabled: true, interval_seconds: 300 })).toEqual([]);
});
