import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import { registerTaskTools, Tasks } from "./tasks.ts";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const promptly = (reply: Promise<unknown>) => Promise.race([reply, wait(500).then(() => "still waiting")]);
type Process = { emit: (text: string) => void; finish: (exitCode?: number) => void; signal?: AbortSignal };

async function fixture(run: (h: ReturnType<typeof harness>, start: (command: string) => Promise<{ id: string; process: Process }>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-task-sleep-"));
  const processes = new Map<string, (process: Process) => void>();
  const tasks = new Tasks(root, { exec: async (command, _cwd, { onData, signal }) => new Promise(resolve => {
    const finish = (exitCode = 0) => { signal?.removeEventListener("abort", abort); resolve({ exitCode }); };
    const abort = () => finish();
    signal?.addEventListener("abort", abort, { once: true });
    processes.get(command)!({ emit: text => onData(Buffer.from(text)), finish, signal });
  }) });
  const h = harness(); h.ctx.cwd = root; h.ctx.isIdle = () => false;
  registerTaskTools(h.pi, tasks);
  await h.emit("session_start");
  const start = async (command: string) => {
    const started = new Promise<Process>(resolve => processes.set(command, resolve));
    const id = (await h.call("bash", { command, run_in_background: true })).details.task_id;
    return { id, process: await started };
  };
  try { await run(h, start); }
  finally { await h.emit("session_shutdown"); await tasks.shutdown(); await rm(root, { recursive: true, force: true }); }
}

test("a task completion wakes sleep with its notice and replaces the separate completion turn", () => fixture(async (h, start) => {
  const { id, process } = await start("build | tail");
  const other = await start("server");
  const reply = h.call("sleep", { seconds: 1800 });
  await wait(30);
  process.emit("built\n"); process.finish(2);
  expect(await promptly(reply)).toMatchObject({ details: {
    woke: "task",
    completed: [{ task_id: id, status: "failed", exit_code: 2, notice: `Background Bash task ${id} is failed (exit 2).` }],
    message: "Use task_output to inspect the results before claiming success.",
  } });
  expect((await reply as any).details.running).toBeUndefined();
  h.ctx.isIdle = () => true;
  await h.emit("before_agent_start");
  await wait(80);
  expect(h.sentMessages).toEqual([]);
  expect((await h.call("task_output", { task_id: id })).details.output).toBe("built\n");
  expect((await h.call("task_query", { task_id: other.id })).details.status).toBe("running");
}));

test("a completion that arrived before sleep returns immediately", () => fixture(async (h, start) => {
  const { id, process } = await start("quick");
  process.finish();
  await wait(30);
  expect(await promptly(h.call("sleep", { seconds: 1800 }))).toMatchObject({ details: { woke: "task", completed: [{ task_id: id, status: "succeeded" }] } });
  h.ctx.isIdle = () => true;
  await h.emit("before_agent_start");
  expect(h.sentMessages).toEqual([]);
}));

test("a sleep that times out reports progress for running tasks without moving the output cursor", () => fixture(async (h, start) => {
  const { id, process } = await start("long job");
  process.emit("step 1\n");
  const reply = await h.call("sleep", { seconds: 1 });
  expect(reply.details).toMatchObject({ woke: "timeout", completed: [], running: [{ task_id: id, command: "long job", status: "running", output_bytes: 7, recent_output: "step 1\n" }] });
  expect(reply.details.slept_seconds).toBeGreaterThanOrEqual(0.9);
  expect(reply.details.running[0].deadline_remaining_seconds).toBeGreaterThan(1790);
  expect(reply.details.message).toContain("sleep again");
  expect((await h.call("task_output", { task_id: id })).details.output).toBe("step 1\n");
}));

test("a sleep with no running tasks says so on timeout", () => fixture(async h => {
  const reply = await h.call("sleep", { seconds: 1 });
  expect(reply.details).toMatchObject({ woke: "timeout", completed: [], running: [], message: "Sleep finished. No background tasks are running on this branch." });
}));

test.each(["message", "instruction", "health-alert", "checkin", "review-reminder"])("swarm %s activity wakes sleep", kind => fixture(async h => {
  const reply = h.call("sleep", { seconds: 1800 });
  await wait(10);
  h.pi.events.emit("pi:swarm-activity", { kind });
  expect(await promptly(reply)).toMatchObject({ details: { woke: "swarm", completed: [], message: "A swarm message is waiting. Read and handle it." } });
}));

test("canceling sleep leaves the task running and later completion still notifies", () => fixture(async (h, start) => {
  const { id, process } = await start("job");
  const controller = new AbortController();
  const reply = h.call("sleep", { seconds: 1800 }, controller.signal);
  reply.catch(() => {});
  await wait(10);
  controller.abort(new Error("cancel sleep"));
  await expect(reply).rejects.toThrow("cancel sleep");
  expect(process.signal?.aborted).toBe(false);
  process.finish();
  await wait(30);
  h.ctx.isIdle = () => true;
  await h.emit("before_agent_start");
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0].message.content).toContain(`${id} is succeeded`);
}));

test("completions on another branch do not wake sleep", () => fixture(async (h, start) => {
  const { process } = await start("elsewhere");
  const branch = [...h.entries];
  h.entries.length = 0;
  await h.emit("session_tree");
  const reply = h.call("sleep", { seconds: 1800 });
  process.finish();
  expect(await Promise.race([reply, wait(60).then(() => "still waiting")])).toBe("still waiting");
  h.entries.push(...branch);
  await h.emit("input", { text: "stop", source: "interactive", streamingBehavior: "steer" });
  expect(await promptly(reply)).toMatchObject({ details: { woke: "steering" } });
}));

test("sleep rejects durations outside 1 to 1800 seconds", () => fixture(async h => {
  for (const seconds of [0, -1, 1.5, 1801, NaN]) await expect(h.call("sleep", { seconds })).rejects.toThrow("between 1 and 1800");
}));
