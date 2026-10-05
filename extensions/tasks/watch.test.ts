import { expect, test } from "bun:test";
import { appendFile, chmod, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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
  await tasks.stop(id);
  await waitFor(() => tasks.query(id).finished_at !== undefined);
  const { created_at, finished_at } = tasks.query(id);
  const finished = await tasks.progress(id, Date.parse(finished_at!) + 600_000);
  expect(finished.elapsed_seconds).toBe(Math.floor((Date.parse(finished_at!) - Date.parse(created_at)) / 1000));
  expect(finished.output_silence_seconds).toBeLessThan(5);
  expect(finished.deadline_remaining_seconds).toBeNull();
}));

test("watch reports are opt-in, persistent, branch-owned and wake on every interval", () => fixture(async (h, tasks) => {
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
  expect(h.sentMessages[1].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  expect(h.sentMessages[1].message.details.warnings).toEqual(["expected duration exceeded"]);
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

test("normal progress reports wake the agent without warning thresholds", () => fixture(async h => {
  const reply = await h.call("bash", { command: "fake job", run_in_background: true });
  await h.call("task_watch", { task_id: reply.details.task_id, interval_seconds: 1 });
  await waitFor(() => h.sentMessages.length >= 2);
  for (const report of h.sentMessages) {
    expect(report.message.details.warnings).toEqual([]);
    expect(report.message.content).toContain("Check the task and report progress to the user");
    expect(report.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  }
}));

test("watch reports wait for idle and restored watches resume without changing deadlines", () => fixture(async (h, tasks) => {
  h.ctx.isIdle = () => false;
  const reply = await h.call("bash", { command: "fake job", run_in_background: true, timeout: 120 });
  const id = reply.details.task_id, deadline = tasks.query(id).deadline_at;
  await h.call("task_watch", { task_id: id, interval_seconds: 1, silence_seconds: 1 });
  await new Promise(resolve => setTimeout(resolve, 1200)); expect(h.sentMessages).toHaveLength(0);
  h.ctx.isIdle = () => true; await h.emit("session_tree");
  await waitFor(() => h.sentMessages.length > 0);
  expect(h.sentMessages[0].message.details.warnings).toContain("captured output is silent");
  expect(tasks.query(id).deadline_at).toBe(deadline);
}));

test("log watches resolve against task cwd and survive reload and branch changes", () => fixture(async (h, tasks, root) => {
  const id = (await h.call("bash", { command: "fake job", run_in_background: true })).details.task_id;
  const path = join(root, "job.log");
  await writeFile(path, "first line\n");
  h.ctx.cwd = tmpdir();
  const reply = await h.call("task_watch", { task_id: id, log_path: "job.log", interval_seconds: 1 });
  expect(reply.details.watch.log_path).toBe(path);
  expect(reply.details.progress.log).toMatchObject({ path, bytes: 11, recent_output: "first line\n" });
  const branch = h.entries.splice(0);
  await h.emit("session_tree");
  await expect(h.call("task_watch", { task_id: id, log_path: path })).rejects.toThrow("not on this session branch");
  h.entries.push(...branch);
  await h.emit("session_shutdown", { reason: "reload" });
  const reloaded = harness(); reloaded.ctx.isIdle = () => true;
  reloaded.entries.push(...branch);
  registerTaskTools(reloaded.pi, tasks);
  try {
    await reloaded.emit("session_start");
    await appendFile(path, "second line\n");
    await waitFor(() => reloaded.sentMessages.length > 0);
    const report = reloaded.sentMessages[0].message;
    expect(report.details.log).toMatchObject({ path, bytes: 23, recent_output: "first line\nsecond line\n" });
    expect(report.content).toContain("Recent log lines:");
    expect(report.content).toContain("does not prove that the process is stuck");
    expect((await tasks.output(id)).output).toBe("progress €\n");
    await reloaded.call("task_watch", { task_id: id, enabled: false });
    const count = reloaded.sentMessages.length;
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(reloaded.sentMessages).toHaveLength(count);
  } finally { await reloaded.emit("session_shutdown"); }
}));

test("log progress handles growth, truncation, rotation and bounded UTF-8 tails", () => fixture(async (h, tasks, root) => {
  const id = (await h.call("bash", { command: "fake job", run_in_background: true })).details.task_id;
  const path = join(root, "job.log");
  const text = "€".repeat(1000) + "\n1\n2\n3\n4\n5";
  await writeFile(path, text);
  const first = (await tasks.progress(id, Date.now(), path)).log!;
  expect(first.bytes).toBe(Buffer.byteLength(text));
  expect(first.recent_output).toBe("1\n2\n3\n4\n5");
  await writeFile(path, "€".repeat(1000));
  const tail = (await tasks.progress(id, Date.now(), path)).log!;
  expect(Buffer.byteLength(tail.recent_output)).toBeLessThanOrEqual(2048);
  expect(tail.recent_output).not.toContain("�");
  await appendFile(path, "grow");
  expect((await tasks.progress(id, Date.now(), path)).log!.bytes).toBe(3004);
  await writeFile(path, "short");
  expect((await tasks.progress(id, Date.now(), path)).log).toMatchObject({ bytes: 5, recent_output: "short" });
  await rename(path, path + ".old");
  await writeFile(path, "replacement");
  const timestamp = new Date(Date.now() - 10_000);
  await utimes(path, timestamp, timestamp);
  const rotated = (await tasks.progress(id, timestamp.getTime() + 15_000, path)).log!;
  expect(rotated).toMatchObject({ bytes: 11, recent_output: "replacement", unchanged_seconds: 15 });
}));

test("missing, unreadable and nonregular logs do not break reports and recover when replaced", () => fixture(async (h, tasks, root) => {
  const id = (await h.call("bash", { command: "fake job", run_in_background: true })).details.task_id;
  const path = join(root, "missing.log");
  const reply = await h.call("task_watch", { task_id: id, log_path: path, interval_seconds: 1 });
  expect(reply.details.progress.log.error).toContain("ENOENT");
  await waitFor(() => h.sentMessages.length > 0);
  expect(h.sentMessages[0].message.details.warnings).toContain("watched log is unavailable");
  expect(h.sentMessages[0].message.content).toContain("unavailable");
  await writeFile(path, "recovered");
  await waitFor(() => h.sentMessages.length > 1);
  expect(h.sentMessages[1].message.details.log).toMatchObject({ bytes: 9, recent_output: "recovered" });
  expect((await tasks.progress(id, Date.now(), root)).log!.error).toContain("Not a regular file");
  const fifo = join(root, "fifo");
  execFileSync("mkfifo", [fifo]);
  expect((await tasks.progress(id, Date.now(), fifo)).log!.error).toContain("Not a regular file");
  if (process.getuid?.() !== 0) {
    await chmod(path, 0);
    try { expect((await tasks.progress(id, Date.now(), path)).log!.error).toContain("EACCES"); }
    finally { await chmod(path, 0o600); }
  }
  await expect(h.call("task_watch", { task_id: id, log_path: "  " })).rejects.toThrow("log_path must not be empty");
}));

test("captured silence and unchanged log warnings are separate", () => {
  const watch: Watch = { task_id: "task", enabled: true, interval_seconds: 300, silence_seconds: 60 };
  const log = { path: "/job.log", bytes: 10, modified_at: new Date().toISOString(), unchanged_seconds: 0, recent_output: "progress" };
  expect(watchWarnings({ elapsed_seconds: 100, output_silence_seconds: 100, log }, watch)).toEqual(["captured output is silent"]);
  expect(watchWarnings({ elapsed_seconds: 100, output_silence_seconds: 0, log: { ...log, unchanged_seconds: 100 } }, watch)).toEqual(["watched log is unchanged"]);
  expect(watchWarnings({ elapsed_seconds: 100, output_silence_seconds: 100, log: { ...log, unchanged_seconds: 100 } }, watch)).toEqual(["captured output is silent", "watched log is unchanged"]);
});

test("expected-duration and silence warnings are independent and require configured thresholds", () => {
  const watch: Watch = { task_id: "task", enabled: true, interval_seconds: 300, expected_seconds: 600, silence_seconds: 60 };
  expect(watchWarnings({ elapsed_seconds: 599, output_silence_seconds: 59 }, watch)).toEqual([]);
  expect(watchWarnings({ elapsed_seconds: 600, output_silence_seconds: 59 }, watch)).toEqual(["expected duration exceeded"]);
  expect(watchWarnings({ elapsed_seconds: 600, output_silence_seconds: 60 }, watch)).toEqual(["expected duration exceeded", "captured output is silent"]);
  expect(watchWarnings({ elapsed_seconds: 9999, output_silence_seconds: 9999 }, { task_id: "task", enabled: true, interval_seconds: 300 })).toEqual([]);
});
