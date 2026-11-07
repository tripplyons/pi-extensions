import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import { registerTaskTools, taskKey, Tasks } from "./tasks.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const promptly = (reply: Promise<unknown>) => Promise.race([reply, sleep(500).then(() => "still waiting")]);
type Process = { emit: (text: string) => void; finish: () => void; signal?: AbortSignal };

async function fixture(run: (h: ReturnType<typeof harness>, started: Promise<Process>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-task-steering-"));
  let start!: (process: Process) => void;
  const started = new Promise<Process>(resolve => { start = resolve; });
  const tasks = new Tasks(root, { exec: async (_command, _cwd, { onData, signal }) => new Promise(resolve => {
    const finish = () => { signal?.removeEventListener("abort", finish); resolve({ exitCode: 0 }); };
    signal?.addEventListener("abort", finish, { once: true });
    start({ emit: text => onData(Buffer.from(text)), finish, signal });
  }) });
  const h = harness(); h.ctx.cwd = root; h.ctx.isIdle = () => false;
  registerTaskTools(h.pi, tasks);
  try { await run(h, started); }
  finally { await h.emit("session_shutdown"); await rm(root, { recursive: true, force: true }); }
}

test("steering promotes foreground Bash without canceling its process or changing its deadline", () => fixture(async (h, started) => {
  const reports: any[] = [];
  h.pi.events.on("t3:background-tasks", report => { reports.push(report); });
  const controller = new AbortController();
  const reply = h.call("bash", { command: "controlled", timeout: 240 }, controller.signal);
  const process = await started;
  const id = h.entries.find(entry => entry.customType === taskKey)!.data;
  const before = (await h.call("task_query", { task_id: id })).details;
  expect(await h.emit("input", { text: "answer me", source: "interactive", streamingBehavior: "steer" })).toEqual([{ action: "continue" }]);
  expect(await promptly(reply)).toMatchObject({ details: { task_id: id, status: "auto_promoted" } });
  expect((await h.call("task_query", { task_id: id })).details).toMatchObject({ status: "running", deadline_at: before.deadline_at });
  expect(reports.at(-1).tasks).toMatchObject([{ taskId: id, kind: "command" }]);
  controller.abort();
  expect(process.signal?.aborted).toBe(false);
  process.emit("same process\n"); process.finish();
  expect((await h.call("task_output", { task_id: id })).details.output).toBe("same process\n");
}));

test.each(["message", "instruction"])("a swarm %s promotes foreground Bash without canceling its process or changing its deadline", kind => fixture(async (h, started) => {
  const reply = h.call("bash", { command: "controlled", timeout: 240 });
  const process = await started;
  const id = h.entries.find(entry => entry.customType === taskKey)!.data;
  const before = (await h.call("task_query", { task_id: id })).details;
  h.pi.events.emit("pi:swarm-activity", { kind });
  expect(await promptly(reply)).toMatchObject({ details: { task_id: id, status: "auto_promoted" } });
  expect((await h.call("task_query", { task_id: id })).details).toMatchObject({ status: "running", deadline_at: before.deadline_at });
  expect(process.signal?.aborted).toBe(false);
  process.emit("same process\n"); process.finish();
  expect((await h.call("task_output", { task_id: id })).details.output).toBe("same process\n");
}));

test("swarm delivery wakes sleep without stopping the task or waking later sleeps", () => fixture(async (h, started) => {
  const id = (await h.call("bash", { command: "controlled", run_in_background: true })).details.task_id;
  const process = await started;
  const sleeping = h.call("sleep", { seconds: 1800 });
  await sleep(30);
  h.pi.events.emit("pi:swarm-activity", { kind: "instruction" });
  expect(await promptly(sleeping)).toMatchObject({ details: { woke: "swarm", completed: [] } });
  expect(process.signal?.aborted).toBe(false);
  const next = h.call("sleep", { seconds: 1800 });
  expect(await Promise.race([next, sleep(30).then(() => "still waiting")])).toBe("still waiting");
  process.emit("done"); process.finish();
  expect(await promptly(next)).toMatchObject({ details: { woke: "task", completed: [{ task_id: id, status: "succeeded" }] } });
}));

test("follow-up and idle input do not promote foreground Bash", () => fixture(async (h, started) => {
  const reply = h.call("bash", { command: "controlled" });
  const process = await started;
  await h.emit("input", { text: "later", source: "interactive", streamingBehavior: "followUp" });
  await h.emit("input", { text: "idle", source: "interactive" });
  expect(await Promise.race([reply, sleep(30).then(() => "still waiting")])).toBe("still waiting");
  process.emit("native result\n"); process.finish();
  expect(await promptly(reply)).toMatchObject({ content: [{ type: "text", text: "native result\n" }] });
}));

test("steering wakes every sleep and promotes foreground Bash, but follow-up input does not", () => fixture(async (h, started) => {
  const id = (await h.call("bash", { command: "controlled", run_in_background: true })).details.task_id;
  const process = await started;
  const sleeps = [h.call("sleep", { seconds: 1800 }), h.call("sleep", { seconds: 1800 })];
  await sleep(30);
  await h.emit("input", { text: "later", source: "rpc", streamingBehavior: "followUp" });
  expect(await Promise.race([Promise.all(sleeps), sleep(30).then(() => "still waiting")])).toBe("still waiting");
  await h.emit("input", { text: "now", source: "rpc", streamingBehavior: "steer" });
  for (const reply of sleeps) expect(await promptly(reply)).toMatchObject({ details: { woke: "steering", completed: [] } });
  expect(process.signal?.aborted).toBe(false);
  expect((await h.call("task_query", { task_id: id })).details.status).toBe("running");
}));

test("a sleep woken by steering does not acknowledge a later completion", () => fixture(async (h, started) => {
  const id = (await h.call("bash", { command: "controlled", run_in_background: true })).details.task_id;
  const process = await started;
  const reply = h.call("sleep", { seconds: 1800 });
  await h.emit("input", { text: "now", source: "interactive", streamingBehavior: "steer" });
  expect(await promptly(reply)).toMatchObject({ details: { woke: "steering", completed: [] } });
  process.emit("finished"); process.finish();
  await sleep(30);
  h.ctx.isIdle = () => true;
  await h.emit("before_agent_start");
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0].message.content).toContain(`${id} is succeeded`);
  expect((await h.call("task_output", { task_id: id })).details.output).toBe("finished");
}));

test("a task whose output was already read reports its exit quietly instead of waking the conversation", () => fixture(async (h, started) => {
  const id = (await h.call("bash", { command: "swift build 2>&1 | tail -40", run_in_background: true })).details.task_id;
  const process = await started;
  process.emit("error: Build failed\n");
  expect(await h.call("task_output", { task_id: id })).toMatchObject({ details: { status: "running", output: "error: Build failed\n" } });
  // The process exits after the last read, while Pi is still busy.
  process.finish();
  await sleep(30);
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0].options).toEqual({ deliverAs: "nextTurn" });
  expect(h.sentMessages[0].message.content).toBe(`Background Bash task ${id} is succeeded (exit 0; without pipefail, a pipeline reports only its last command's exit code).\nIts output was already read with task_output.`);
  h.ctx.isIdle = () => true;
  await h.emit("before_agent_start");
  expect(h.sentMessages).toHaveLength(1);
}));

test("unread output still wakes the conversation, with the exit code", () => fixture(async (h, started) => {
  const id = (await h.call("bash", { command: "make", run_in_background: true })).details.task_id;
  const process = await started;
  process.emit("seen\n");
  await h.call("task_output", { task_id: id });
  process.emit("unseen\n"); process.finish();
  await sleep(30);
  expect(h.sentMessages).toHaveLength(0);
  h.ctx.isIdle = () => true;
  await h.emit("before_agent_start");
  expect(h.sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  expect(h.sentMessages[0].message.content).toStartWith(`Background Bash task ${id} is succeeded (exit 0).`);
}));
