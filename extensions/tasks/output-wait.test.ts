import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import { registerTaskTools, Tasks } from "./tasks.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(run: (h: ReturnType<typeof harness>, id: string, emit: (text: string) => void, finish: (exitCode?: number) => void) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-output-wait-"));
  let emit!: (text: string) => void, finish!: (exitCode?: number) => void;
  const tasks = new Tasks(root, { exec: async (_command, _cwd, { onData, signal }) => {
    emit = text => onData(Buffer.from(text));
    return new Promise(resolve => {
      const abort = () => finish();
      finish = (exitCode = 0) => { signal?.removeEventListener("abort", abort); resolve({ exitCode }); };
      signal?.addEventListener("abort", abort, { once: true });
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

for (const wait_until_terminal of [false, true]) {
  for (const [requested, expected] of [[120_000, 120_000], [300_000, 300_000], [600_000, 300_000]]) {
    test(`task_output schedules ${expected} ms for a ${requested} ms wait (terminal=${wait_until_terminal})`, () => fixture(async (h, id, _emit, finish) => {
      const timer = spyOn(globalThis, "setTimeout");
      const reply = h.call("task_output", { task_id: id, wait_ms: requested, wait_until_terminal });
      try {
        await sleep(30);
        expect(timer.mock.calls.some(call => call[1] === expected)).toBe(true);
      } finally {
        timer.mockRestore();
        finish();
        await reply;
      }
    }));
  }

  test(`task_output cancels a long wait without stopping the task (terminal=${wait_until_terminal})`, () => fixture(async (h, id) => {
    const controller = new AbortController();
    const reply = h.call("task_output", { task_id: id, wait_ms: 300_000, wait_until_terminal }, controller.signal);
    reply.catch(() => {});
    await sleep(30);
    controller.abort(new Error("cancel wait"));
    await expect(reply).rejects.toThrow("cancel wait");
    expect((await h.call("task_query", { task_id: id })).details.status).toBe("running");
  }));
}

test("task_output waits on a silent live task until wait_ms expires", () => fixture(async (h, id) => {
  const start = performance.now();
  const reply = await h.call("task_output", { task_id: id, wait_ms: 80 });
  expect(performance.now() - start).toBeGreaterThanOrEqual(60);
  expect(reply.details).toMatchObject({ status: "running", output: "", next_offset: 0 });
}));

test("task_output returns unread output immediately even with a long wait", () => fixture(async (h, id, emit) => {
  emit("already captured");
  const reply = h.call("task_output", { task_id: id, wait_ms: 300_000 });
  expect(await Promise.race([reply, sleep(500).then(() => "still waiting")])).toMatchObject({
    details: { status: "running", output: "already captured", next_offset: 16 },
  });
}));

test("task_output waits at the consumed cursor and wakes on new output", () => fixture(async (h, id, emit) => {
  emit("before");
  expect((await h.call("task_output", { task_id: id })).details.next_offset).toBe(6);
  const reply = h.call("task_output", { task_id: id, wait_ms: 300_000 });
  expect(await Promise.race([reply, sleep(30).then(() => "still waiting")])).toBe("still waiting");
  emit("after");
  expect((await reply).details).toMatchObject({ status: "running", output: "after", next_offset: 11 });
}));

test("terminal wait ignores existing and arriving output without consuming it", () => fixture(async (h, id, emit, finish) => {
  emit("before");
  const reply = h.call("task_output", { task_id: id, wait_ms: 300_000, wait_until_terminal: true });
  expect(await Promise.race([reply, sleep(30).then(() => "waiting")])).toBe("waiting");
  emit("after");
  expect(await Promise.race([reply, sleep(30).then(() => "waiting")])).toBe("waiting");
  // An independent explicit read proves the wait has not consumed output.
  expect((await h.call("task_output", { task_id: id, offset: 0 })).details.output).toBe("beforeafter");
  finish();
  expect((await reply).details).toMatchObject({ status: "succeeded", output: "beforeafter", next_offset: 11 });
  expect((await h.call("task_output", { task_id: id, wait_ms: 300_000, wait_until_terminal: true })).details.output).toBe("");
}));

test("terminal wait uses one deadline despite output and retains unread bytes", () => fixture(async (h, id, emit) => {
  emit("x".repeat(60_000));
  const timer = spyOn(globalThis, "setTimeout");
  const reply = h.call("task_output", { task_id: id, wait_ms: 80, wait_until_terminal: true });
  try {
    await sleep(30); emit("more");
    const result = await reply;
    expect(result.details).toMatchObject({ status: "running", next_offset: 51200 });
    expect(result.details.output).toBe("x".repeat(51200));
    expect(timer.mock.calls.filter(call => call[1] === 80)).toHaveLength(1);
    expect((await h.call("task_output", { task_id: id })).details.output).toBe("x".repeat(8800) + "more");
  } finally { timer.mockRestore(); }
}));

test("terminal wait preserves failure diagnostics and explicit cursor semantics", () => fixture(async (h, id, emit, finish) => {
  emit("build failed\n");
  const reply = h.call("task_output", { task_id: id, offset: 0, wait_ms: 300_000, wait_until_terminal: true });
  expect(await Promise.race([reply, sleep(30).then(() => "waiting")])).toBe("waiting");
  finish(7);
  expect((await reply).details).toMatchObject({ status: "failed", output: "build failed\n", next_offset: 13 });
  expect((await h.call("task_query", { task_id: id })).details.exit_code).toBe(7);
  expect((await h.call("task_output", { task_id: id })).details.output).toBe("build failed\n");
}));

test("terminal wait with no wait_ms remains nonblocking", () => fixture(async (h, id, emit) => {
  emit("ready");
  expect((await h.call("task_output", { task_id: id, wait_until_terminal: true })).details).toMatchObject({ status: "running", output: "ready" });
}));

for (const source of ["user", "swarm"]) {
  test(`terminal wait yields to ${source} steering but not follow-up input`, () => fixture(async (h, id, emit, finish) => {
    emit("before");
    const reply = h.call("task_output", { task_id: id, wait_ms: 300_000, wait_until_terminal: true });
    await h.emit("input", { text: "later", source: "rpc", streamingBehavior: "followUp" });
    expect(await Promise.race([reply, sleep(30).then(() => "waiting")])).toBe("waiting");
    if (source === "user") await h.emit("input", { text: "now", source: "rpc", streamingBehavior: "steer" });
    else h.pi.events.emit("pi:swarm-activity", { kind: "message" });
    expect(await Promise.race([reply, sleep(500).then(() => "waiting")])).toMatchObject({ details: { status: "running", output: "before" } });
    expect((await h.call("task_query", { task_id: id })).details.status).toBe("running");
    const next = h.call("task_output", { task_id: id, wait_ms: 300_000, wait_until_terminal: true });
    emit("after");
    expect(await Promise.race([next, sleep(30).then(() => "waiting")])).toBe("waiting");
    finish();
    expect((await next).details).toMatchObject({ status: "succeeded", output: "after", next_offset: 11 });
  }));
}

test("task_output wakes on completion without new output", () => fixture(async (h, id, _emit, finish) => {
  const reply = h.call("task_output", { task_id: id, wait_ms: 300_000 });
  expect(await Promise.race([reply, sleep(30).then(() => "still waiting")])).toBe("still waiting");
  finish();
  expect((await reply).details).toMatchObject({ status: "succeeded", output: "", next_offset: 0 });
  const completed = h.call("task_output", { task_id: id, wait_ms: 300_000 });
  expect(await Promise.race([completed, sleep(500).then(() => "still waiting")])).toMatchObject({
    details: { status: "succeeded", output: "", next_offset: 0 },
  });
}));
