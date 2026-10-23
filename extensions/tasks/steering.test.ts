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
  const reply = h.call("bash", { command: "controlled", timeout: 240, foreground_wait_seconds: 300 }, controller.signal);
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

test("follow-up and idle input do not promote foreground Bash", () => fixture(async (h, started) => {
  const reply = h.call("bash", { command: "controlled", foreground_wait_seconds: 300 });
  const process = await started;
  await h.emit("input", { text: "later", source: "interactive", streamingBehavior: "followUp" });
  await h.emit("input", { text: "idle", source: "interactive" });
  expect(await Promise.race([reply, sleep(30).then(() => "still waiting")])).toBe("still waiting");
  process.emit("native result\n"); process.finish();
  expect(await promptly(reply)).toMatchObject({ content: [{ type: "text", text: "native result\n" }] });
}));

test("steering releases all output waits, preserves cursors, and does not release later waits", () => fixture(async (h, started) => {
  const id = (await h.call("bash", { command: "controlled", run_in_background: true })).details.task_id;
  const process = await started;
  process.emit("before");
  expect((await h.call("task_output", { task_id: id })).details.next_offset).toBe(6);
  const waits = [h.call("task_output", { task_id: id, wait_ms: 300_000 }), h.call("task_output", { task_id: id, offset: 6, wait_ms: 300_000 })];
  await sleep(30);
  await h.emit("input", { text: "later", source: "rpc", streamingBehavior: "followUp" });
  expect(await Promise.race([Promise.all(waits), sleep(30).then(() => "still waiting")])).toBe("still waiting");
  await h.emit("input", { text: "now", source: "rpc", streamingBehavior: "steer" });
  for (const wait of waits) expect(await promptly(wait)).toMatchObject({ details: { status: "running", output: "", next_offset: 6 } });
  expect(process.signal?.aborted).toBe(false);
  const next = h.call("task_output", { task_id: id, wait_ms: 300_000 });
  expect(await Promise.race([next, sleep(30).then(() => "still waiting")])).toBe("still waiting");
  process.emit("after");
  expect(await promptly(next)).toMatchObject({ details: { status: "running", output: "after", next_offset: 11 } });
  const again = h.call("task_output", { task_id: id, wait_ms: 300_000 });
  await h.emit("input", { text: "again", source: "interactive", streamingBehavior: "steer" });
  expect(await promptly(again)).toMatchObject({ details: { status: "running", output: "", next_offset: 11 } });
}));

test("steering during output setup yields without acknowledging future completion", () => fixture(async (h, started) => {
  const id = (await h.call("bash", { command: "controlled", run_in_background: true })).details.task_id;
  const process = await started;
  const reply = h.call("task_output", { task_id: id, wait_ms: 300_000 });
  await h.emit("input", { text: "now", source: "interactive", streamingBehavior: "steer" });
  expect(await promptly(reply)).toMatchObject({ details: { status: "running", output: "", next_offset: 0 } });
  process.emit("finished"); process.finish();
  await sleep(30);
  h.ctx.isIdle = () => true;
  await h.emit("before_agent_start");
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0].message.content).toContain(`${id} is succeeded`);
  expect((await h.call("task_output", { task_id: id })).details.output).toBe("finished");
}));
