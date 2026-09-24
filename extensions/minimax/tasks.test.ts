import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { Tasks, backgroundTimeout, registerTaskTools, taskKey } from "./tasks.ts";
import { harness } from "../../lib/harness.ts";

const roots: string[] = [];
const managers: Tasks[] = [];
const registrations: ReturnType<typeof harness>[] = [];
afterEach(async () => {
  await Promise.all(registrations.splice(0).map(h => h.emit("session_shutdown")));
  await Promise.all(managers.splice(0).map(tasks => tasks.shutdown()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup(yieldMs = 10, operations?: BashOperations) {
  const root = await mkdtemp(join(tmpdir(), "minimax-jobs-test-")); roots.push(root);
  const tasks = new Tasks(root, operations, yieldMs); managers.push(tasks);
  return { root, tasks };
}
async function taskHarness(operations?: BashOperations) {
  const { root, tasks } = await setup(10, operations);
  const h = harness(); registrations.push(h);
  h.ctx.cwd = root; h.ctx.isIdle = () => false;
  registerTaskTools(h.pi, tasks);
  await h.emit("session_start");
  return { h, tasks };
}
async function settled(tasks: Tasks, id: string) {
  for (let i = 0; i < 100; i++) {
    if (!["running", "stopping"].includes(tasks.query(id).status)) return tasks.query(id);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Task did not settle");
}
const ignore = () => {};

test("foreground promotion keeps one process, deadline, output and completion notification", async () => {
  const { root, tasks } = await setup();
  let id = ""; const completed: string[] = [];
  const reply = await tasks.run(root, { command: "echo $$ > pid; printf before; sleep 0.1; echo $$ >> pid; printf after" }, undefined, value => { id = value; }, value => completed.push(value));
  expect(reply.content[0]).toMatchObject({ type: "text" });
  expect(JSON.parse((reply.content[0] as any).text).status).toBe("auto_promoted");
  expect((await settled(tasks, id)).status).toBe("succeeded");
  const pids = (await readFile(join(root, "pid"), "utf8")).trim().split("\n");
  expect(pids).toHaveLength(2); expect(pids[0]).toBe(pids[1]);
  expect(completed).toEqual([id]);
  expect((await tasks.output(id, undefined)).output).toBe("beforeafter");
  expect((await tasks.output(id, undefined)).output).toBe("");
  expect((await tasks.output(id, 0)).output).toBe("beforeafter");
  expect((await tasks.output(id, undefined)).next_offset).toBe(11);
});

test("promoted foreground deadlines still terminate commands", async () => {
  const { root, tasks } = await setup(); let id = "";
  await tasks.run(root, { command: "sleep 5", timeout: 0.08 }, undefined, value => { id = value; }, ignore);
  const record = await settled(tasks, id);
  expect(record.status).toBe("failed"); expect(record.error).toContain("timed out after 0.08 seconds");
});

test("background survives launching turn abort; stop kills descendants and is idempotent", async () => {
  const { root, tasks } = await setup(); let id = "";
  const controller = new AbortController();
  await tasks.run(root, { command: "sleep 30 & echo $!; wait", run_in_background: true }, controller.signal, value => { id = value; }, ignore);
  controller.abort();
  const output = await tasks.output(id, 0, 30_001);
  const pid = Number(output.output.trim()); expect(pid).toBeGreaterThan(0);
  expect(tasks.query(id).status).toBe("running");
  expect((await tasks.stop(id, "test stop")).status).toBe("canceled");
  expect(() => process.kill(pid, 0)).toThrow();
  expect((await tasks.stop(id)).reason).toBe("test stop");
});

test("foreground abort remains attached before promotion", async () => {
  const { root, tasks } = await setup(1000); let id = "";
  const controller = new AbortController();
  const running = tasks.run(root, { command: "sleep 30" }, controller.signal, value => { id = value; }, ignore);
  controller.abort();
  await expect(running).rejects.toThrow();
  expect(tasks.query(id).status).toBe("canceled");
});

test("output is byte-bounded, explicit offsets do not move the cursor, wait can be aborted", async () => {
  const { root, tasks } = await setup(); let id = "";
  await tasks.run(root, { command: "printf 'héllo'; sleep 30", run_in_background: true }, undefined, value => { id = value; }, ignore);
  expect(await tasks.output(id, undefined, 1000)).toMatchObject({ output: "héllo", next_offset: 6 });
  expect(await tasks.output(id, 0)).toMatchObject({ output: "héllo", next_offset: 6 });
  const controller = new AbortController();
  const waiting = tasks.output(id, undefined, 30_000, controller.signal);
  controller.abort(); await expect(waiting).rejects.toThrow();
  expect(tasks.query(id).status).toBe("running");
  await tasks.stop(id);
  await tasks.run(root, { command: "head -c 60000 /dev/zero", run_in_background: true }, undefined, value => { id = value; }, ignore);
  await settled(tasks, id);
  expect((await tasks.output(id, undefined)).next_offset).toBe(51200);
  expect((await tasks.output(id, undefined)).next_offset).toBe(60000);
});

test("persisted output survives reload and unfinished tasks become lost", async () => {
  const { root, tasks } = await setup(); let id = "";
  await tasks.run(root, { command: "printf saved" }, undefined, value => { id = value; }, ignore);
  await settled(tasks, id);
  const fresh = new Tasks(root);
  expect(fresh.query(id).status).toBe("succeeded");
  expect((await fresh.output(id, 0)).output).toBe("saved");
  const record = tasks.query(id);
  await writeFile(join(root, `${id}.json`), JSON.stringify({ ...record, status: "running" }));
  expect(fresh.query(id).status).toBe("lost");
  expect(backgroundTimeout()).toBe(1800);
  expect(backgroundTimeout(-1)).toBe(1800);
  expect(backgroundTimeout(1)).toBe(1);
  expect(backgroundTimeout(1e12)).toBe(2147483.647);
});

test("tool authorization and notifications follow the owning branch", async () => {
  const { root, tasks } = await setup();
  const h = harness(); h.ctx.cwd = root; h.ctx.isIdle = () => true;
  h.pi.sendMessage = (message: any) => h.sent.push(message.content);
  registerTaskTools(h.pi, tasks);
  await h.emit("session_start");
  await h.call("bash", { command: "sleep 0.05; echo complete", run_in_background: true });
  const branch = [...h.entries];
  const id = branch.find(entry => entry.customType === taskKey).data;
  h.entries.length = 0; await h.emit("session_switch");
  await settled(tasks, id); expect(h.sent).toEqual([]);
  await expect(h.call("task_query", { task_id: id })).rejects.toThrow("not on this session branch");
  await expect(h.call("task_output", { task_id: id })).rejects.toThrow("not on this session branch");
  h.entries.splice(0, h.entries.length, ...branch); await h.emit("session_tree");
  expect(h.sent).toHaveLength(1); expect(h.sent[0]).toContain(id);
  await h.emit("session_tree"); expect(h.sent).toHaveLength(1);
  expect(JSON.parse((await h.call("task_query", { status: "succeeded" })).content[0].text)).toHaveLength(1);
});

test("completion waits for idle and automatic output cursors are session-scoped", async () => {
  const { root, tasks } = await setup();
  const h = harness(); h.ctx.cwd = root;
  let idle = false;
  h.ctx.isIdle = () => idle;
  h.pi.sendMessage = (message: any) => h.sent.push(message.content);
  registerTaskTools(h.pi, tasks);
  await h.emit("session_start");
  await h.call("bash", { command: "printf completed", run_in_background: true });
  const id = h.entries.find(entry => entry.customType === taskKey).data;
  await settled(tasks, id);
  expect(h.sent).toEqual([]);
  idle = true;
  for (let i = 0; i < 50 && !h.sent.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(h.sent).toHaveLength(1);
  const output = async () => JSON.parse((await h.call("task_output", { task_id: id })).content[0].text).output;
  expect(await output()).toBe("completed");
  expect(await output()).toBe("");
  h.ctx.sessionManager.getSessionId = () => "forked-session";
  expect(await output()).toBe("completed");
  await h.emit("session_shutdown");
});

for (const tool of ["task_output", "task_query"]) {
  for (const [command, status] of [["printf completed", "succeeded"], ["exit 7", "failed"]]) {
    test(`${tool} observing ${status} prevents a stale completion wake-up`, async () => {
      const { h, tasks } = await taskHarness();
      const { task_id: id } = (await h.call("bash", { command, run_in_background: true })).details;
      await settled(tasks, id);
      expect(h.sentMessages).toHaveLength(0);
      expect((await h.call(tool, { task_id: id })).details.status).toBe(status);
      h.ctx.isIdle = () => true;
      for (const event of ["before_agent_start", "session_tree", "session_switch"]) await h.emit(event);
      expect(h.sentMessages).toHaveLength(0);
      expect((await tasks.output(id, 0)).status).toBe(status);
    });
  }
}

test("reading a completed auto-promoted foreground task suppresses its notification", async () => {
  const { h, tasks } = await taskHarness();
  const started = (await h.call("bash", { command: "sleep 0.05; printf completed" })).details;
  expect(started.status).toBe("auto_promoted");
  await settled(tasks, started.task_id);
  expect((await h.call("task_output", { task_id: started.task_id })).details.status).toBe("succeeded");
  h.ctx.isIdle = () => true;
  await h.emit("session_tree");
  expect(h.sentMessages).toHaveLength(0);
});

test("a rejected output read leaves the completion pending", async () => {
  const { h, tasks } = await taskHarness();
  const { task_id: id } = (await h.call("bash", { command: "true", run_in_background: true })).details;
  await settled(tasks, id);
  await expect(h.call("task_output", { task_id: id, offset: -1 })).rejects.toThrow("offset must be");
  h.ctx.isIdle = () => true;
  await h.emit("session_tree");
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0].message.content).toContain(id);
});

test("stopping a task acknowledges the cancellation without another turn", async () => {
  const { h, tasks } = await taskHarness();
  const { task_id: id } = (await h.call("bash", { command: "sleep 30", run_in_background: true })).details;
  expect((await h.call("task_stop", { task_id: id })).details.status).toBe("canceled");
  expect(tasks.query(id).status).toBe("canceled");
  h.ctx.isIdle = () => true;
  await h.emit("session_tree");
  expect(h.sentMessages).toHaveLength(0);
});

test("terminal output acknowledges completion without consuming the remaining output", async () => {
  const { h, tasks } = await taskHarness();
  const { task_id: id } = (await h.call("bash", { command: "head -c 60000 /dev/zero", run_in_background: true })).details;
  await settled(tasks, id);
  expect((await h.call("task_output", { task_id: id })).details).toMatchObject({ status: "succeeded", next_offset: 51200 });
  h.ctx.isIdle = () => true;
  await h.emit("session_tree");
  expect(h.sentMessages).toHaveLength(0);
  const remaining = (await h.call("task_output", { task_id: id })).details;
  expect(remaining.output).toHaveLength(8800);
  expect(remaining.next_offset).toBe(60000);
});

test("filtered query acknowledges only returned terminal tasks", async () => {
  const { h, tasks } = await taskHarness();
  const success = (await h.call("bash", { command: "true", run_in_background: true })).details.task_id;
  const failure = (await h.call("bash", { command: "exit 7", run_in_background: true })).details.task_id;
  await Promise.all([settled(tasks, success), settled(tasks, failure)]);
  expect((await h.call("task_query", { status: "succeeded" })).details.map((task: any) => task.task_id)).toEqual([success]);
  h.ctx.isIdle = () => true;
  await h.emit("session_tree");
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0].message.content).toContain(failure);
  expect(h.sentMessages[0].message.content).not.toContain(success);
});

test("unfiltered query acknowledges every returned terminal task", async () => {
  const { h, tasks } = await taskHarness();
  const ids = [];
  for (const command of ["true", "exit 7"]) ids.push((await h.call("bash", { command, run_in_background: true })).details.task_id);
  await Promise.all(ids.map(id => settled(tasks, id)));
  expect((await h.call("task_query", {})).details).toHaveLength(2);
  h.ctx.isIdle = () => true;
  await h.emit("session_tree");
  expect(h.sentMessages).toHaveLength(0);
});

test("unobserved completions are batched into one wake-up instead of queued follow-up turns", async () => {
  const { h, tasks } = await taskHarness();
  const ids = [];
  for (const command of ["true", "exit 7", "printf done"]) ids.push((await h.call("bash", { command, run_in_background: true })).details.task_id);
  await Promise.all(ids.map(id => settled(tasks, id)));
  expect(h.sentMessages).toHaveLength(0);
  const send = h.pi.sendMessage;
  h.pi.sendMessage = (message: any, options: any) => {
    send(message, options);
    h.ctx.isIdle = () => false;
  };
  h.ctx.isIdle = () => true;
  await h.emit("session_tree");
  expect(h.sentMessages).toHaveLength(1);
  for (const id of ids) expect(h.sentMessages[0].message.content).toContain(id);
  expect(h.sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  h.ctx.isIdle = () => true;
  await h.emit("before_agent_start");
  expect(h.sentMessages).toHaveLength(1);
});

test("a completion racing a running output snapshot still notifies", async () => {
  let finish!: () => void;
  const exit = new Promise<{ exitCode: number }>(resolve => { finish = () => resolve({ exitCode: 0 }); });
  const { h, tasks } = await taskHarness({ exec: async (_command, _cwd, { signal }) => {
    signal?.addEventListener("abort", finish, { once: true });
    return exit;
  } });
  const { task_id: id } = (await h.call("bash", { command: "controlled", run_in_background: true })).details;
  const output = tasks.output.bind(tasks);
  tasks.output = async (...args) => {
    const snapshot = await output(...args);
    finish();
    await settled(tasks, id);
    return snapshot;
  };
  expect((await h.call("task_output", { task_id: id })).details.status).toBe("running");
  expect(tasks.query(id).status).toBe("succeeded");
  h.ctx.isIdle = () => true;
  await h.emit("session_tree");
  expect(h.sentMessages).toHaveLength(1);
  expect(h.sentMessages[0].message.content).toContain(id);
});

test("an aborted terminal read does not acknowledge the completion", async () => {
  const { h, tasks } = await taskHarness();
  const { task_id: id } = (await h.call("bash", { command: "true", run_in_background: true })).details;
  await settled(tasks, id);
  const controller = new AbortController();
  const output = tasks.output.bind(tasks);
  tasks.output = async (...args) => {
    const value = await output(...args);
    controller.abort();
    return value;
  };
  await expect(h.call("task_output", { task_id: id }, controller.signal)).rejects.toThrow();
  h.ctx.isIdle = () => true;
  await h.emit("session_tree");
  expect(h.sentMessages).toHaveLength(1);
});
