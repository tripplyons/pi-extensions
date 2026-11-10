import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import { groupAlive, registerTaskTools, Tasks } from "./tasks.ts";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const text = (reply: any) => reply.content.map((part: { text: string }) => part.text).join("");

// These use the real local shell: tracking depends on its process group.
async function fixture(run: (h: ReturnType<typeof harness>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-task-detached-"));
  const tasks = new Tasks(root, undefined, 5_000);
  const h = harness(); h.ctx.cwd = root; h.ctx.isIdle = () => false;
  registerTaskTools(h.pi, tasks);
  await h.emit("session_start");
  try { await run(h); }
  finally { await h.emit("session_shutdown"); await tasks.shutdown(); await rm(root, { recursive: true, force: true }); }
}

test("a nohup job wakes sleep when it exits, after its command returned", () => fixture(async h => {
  const launch = await h.call("bash", { command: "nohup sleep 1 >/dev/null 2>&1 &\necho launched" });
  expect(text(launch)).toContain("launched");
  expect(text(launch)).toMatch(/still running \(process group \d+\); sleep wakes when they all exit/);
  const started = Date.now();
  const reply = await h.call("sleep", { seconds: 60 });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(reply.details).toMatchObject({ woke: "process", completed: [], processes_exited: [{ command: expect.stringContaining("nohup sleep 1") }] });
  // Reported once: the next sleep waits as asked.
  expect((await h.call("sleep", { seconds: 1 })).details).toMatchObject({ woke: "timeout", message: "Sleep finished. No background tasks are running on this branch." });
}));

test("a job that exited before sleep starts returns at once", () => fixture(async h => {
  await h.call("bash", { command: "(sleep 0.2) >/dev/null 2>&1 &" });
  await wait(1_600);
  const started = Date.now();
  expect((await h.call("sleep", { seconds: 60 })).details).toMatchObject({ woke: "process" });
  expect(Date.now() - started).toBeLessThan(500);
}));

test("a timed-out sleep lists jobs still running and a command without them adds no notice", () => fixture(async h => {
  expect(text(await h.call("bash", { command: "echo plain" }))).not.toContain("process group");
  await h.call("bash", { command: "sleep 30 >/dev/null 2>&1 &" });
  const reply = await h.call("sleep", { seconds: 1 });
  expect(reply.details).toMatchObject({ woke: "timeout", detached: [{ command: "sleep 30 >/dev/null 2>&1 &" }], message: "Sleep finished. Report progress from the snapshot, or sleep again." });
  const pgid = reply.details.detached[0].pgid;
  expect(groupAlive(pgid)).toBe(true);
  process.kill(-pgid, "SIGKILL");
}));
