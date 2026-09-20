import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tasks, backgroundTimeout, registerTaskTools, taskKey } from "./tasks.ts";
import { harness } from "../../lib/harness.ts";

const roots: string[] = [];
const managers: Tasks[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(tasks => tasks.shutdown()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup(yieldMs = 10) {
  const root = await mkdtemp(join(tmpdir(), "minimax-jobs-test-")); roots.push(root);
  const tasks = new Tasks(root, undefined, yieldMs); managers.push(tasks);
  return { root, tasks };
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
