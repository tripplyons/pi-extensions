import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import { registerTaskTools, Tasks } from "./tasks.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(run: (h: ReturnType<typeof harness>, id: string, emit: (text: string) => void, finish: () => void) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-output-wait-"));
  let emit!: (text: string) => void, finish!: () => void;
  const tasks = new Tasks(root, { exec: async (_command, _cwd, { onData, signal }) => {
    emit = text => onData(Buffer.from(text));
    return new Promise(resolve => {
      finish = () => { signal?.removeEventListener("abort", finish); resolve({ exitCode: 0 }); };
      signal?.addEventListener("abort", finish, { once: true });
    });
  } });
  const h = harness(); h.ctx.cwd = root; h.ctx.isIdle = () => false;
  registerTaskTools(h.pi, tasks);
  try {
    const id = (await h.call("bash", { command: "controlled", run_in_background: true })).details.task_id;
    await run(h, id, emit, finish);
  } finally {
    await h.emit("session_shutdown");
    await rm(root, { recursive: true, force: true });
  }
}

test("task_output waits on a silent live task until wait_ms expires", () => fixture(async (h, id) => {
  const start = performance.now();
  const reply = await h.call("task_output", { task_id: id, wait_ms: 80 });
  expect(performance.now() - start).toBeGreaterThanOrEqual(60);
  expect(reply.details).toMatchObject({ status: "running", output: "", next_offset: 0 });
}));

test("task_output returns unread output immediately even with a long wait", () => fixture(async (h, id, emit) => {
  emit("already captured");
  const reply = h.call("task_output", { task_id: id, wait_ms: 30_000 });
  expect(await Promise.race([reply, sleep(500).then(() => "still waiting")])).toMatchObject({
    details: { status: "running", output: "already captured", next_offset: 16 },
  });
}));

test("task_output waits at the consumed cursor and wakes on new output", () => fixture(async (h, id, emit) => {
  emit("before");
  expect((await h.call("task_output", { task_id: id })).details.next_offset).toBe(6);
  const reply = h.call("task_output", { task_id: id, wait_ms: 30_000 });
  expect(await Promise.race([reply, sleep(30).then(() => "still waiting")])).toBe("still waiting");
  emit("after");
  expect((await reply).details).toMatchObject({ status: "running", output: "after", next_offset: 11 });
}));

test("task_output wakes on completion without new output", () => fixture(async (h, id, _emit, finish) => {
  const reply = h.call("task_output", { task_id: id, wait_ms: 30_000 });
  expect(await Promise.race([reply, sleep(30).then(() => "still waiting")])).toBe("still waiting");
  finish();
  expect((await reply).details).toMatchObject({ status: "succeeded", output: "", next_offset: 0 });
  const completed = h.call("task_output", { task_id: id, wait_ms: 30_000 });
  expect(await Promise.race([completed, sleep(500).then(() => "still waiting")])).toMatchObject({
    details: { status: "succeeded", output: "", next_offset: 0 },
  });
}));
