import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harness } from "../../lib/harness.ts";
import { registerTaskTools, taskKey, Tasks } from "../tasks/tasks.ts";
import install from "./index.ts";
import { SwarmStore } from "./state.ts";
import { Workers } from "./worker.ts";

// Exercise real inbox polling and delivery. Only the external process and pane
// checks are mocked; no workers, shell commands, or live services are started.
test.each(["bash", "task_output"])("swarm inbox steering releases a pending %s wait without stopping its process", async tool => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-task-steering-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const alive = Workers.prototype.alive;
  Workers.prototype.alive = async () => true;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let processSignal: AbortSignal | undefined;
  const tasks = new Tasks(join(root, "tasks"), { exec: async (_command, _cwd, { signal }) => new Promise(resolve => {
    processSignal = signal;
    signal?.addEventListener("abort", () => resolve({ exitCode: 0 }), { once: true });
    ready();
  }) });
  const h = harness();
  h.ctx.cwd = root;
  h.ctx.isIdle = () => false;
  registerTaskTools(h.pi, tasks);
  install(h.pi);
  try {
    await h.command("swarm:start", "Test inbox steering");
    const identity = h.entries.find(entry => entry.customType === "pi:swarm")!.data;
    const store = new SwarmStore(join(root, "swarm"));
    const child = await store.reserve(identity.run, identity.node, "Worker", "Report progress");
    let id: string;
    let waiting: Promise<any>;
    if (tool === "bash") {
      waiting = h.call("bash", { command: "controlled", timeout: 240, foreground_wait_seconds: 300 });
      await started;
      id = h.entries.find(entry => entry.customType === taskKey)!.data;
    } else {
      id = (await h.call("bash", { command: "controlled", timeout: 240, run_in_background: true })).details.task_id;
      await started;
      waiting = h.call("task_output", { task_id: id, wait_ms: 300_000 });
    }
    const before = (await h.call("task_query", { task_id: id })).details;
    await store.send(identity.run, child.id, identity.node, "message", "Inspect my result now.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = await Promise.race([
      waiting,
      new Promise(resolve => { timer = setTimeout(() => resolve("still waiting"), 3500); }),
    ]).finally(() => clearTimeout(timer));
    expect(reply).toMatchObject({ details: { task_id: id, status: tool === "bash" ? "auto_promoted" : "running" } });
    expect(processSignal?.aborted).toBe(false);
    expect((await h.call("task_query", { task_id: id })).details).toMatchObject({ status: "running", deadline_at: before.deadline_at });
    expect(h.sentMessages.find(item => item.message.customType === "swarm-message")).toMatchObject({
      message: { content: expect.stringContaining("Inspect my result now.") },
      options: { triggerTurn: true, deliverAs: "steer" },
    });
    expect(await store.inbox(identity.run, identity.node)).toEqual([]);
  } finally {
    await h.emit("session_shutdown");
    Workers.prototype.alive = alive;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
