import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Type } from "typebox";
import { createBashTool, createLocalBashOperations, type BashOperations, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { result, stateRoot } from "../../lib/common.ts";
import { minimaxEnabled } from "../../lib/minimax.ts";
import { renderCall as renderCommandCall } from "../shell/command-preview.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";

export const taskKey = "rework:minimax-task";
export const taskStatuses = ["queued", "running", "stopping", "succeeded", "failed", "canceled", "lost"] as const;
type Status = typeof taskStatuses[number];
type Record = { task_id: string; command: string; cwd: string; status: Status; created_at: string; finished_at?: string; error?: string; exit_code?: number | null; reason?: string };
type Running = { record: Record; controller: AbortController; events: EventEmitter; done: Promise<void>; output?: Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>; background: boolean; error?: Error };
export function foregroundTimeout(timeout?: number) {
  return timeout === undefined || !Number.isFinite(timeout) || timeout <= 0 ? 120 : Math.min(timeout, 300);
}
export function backgroundTimeout(timeout?: number) {
  return timeout === undefined || !Number.isFinite(timeout) || timeout <= 0 ? 1800 : Math.min(timeout, 2147483.647);
}
const terminal = (status: Status) => !["queued", "running", "stopping"].includes(status);

export class Tasks {
  private running = new Map<string, Running>();
  private cursors = new Map<string, number>();
  constructor(readonly root = join(stateRoot(), "minimax", "tasks"), private operations: BashOperations = createLocalBashOperations(), private yieldMs = 15_000) {}
  private path(id: string, suffix: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid task ID");
    return join(this.root, `${id}.${suffix}`);
  }
  private save(record: Record) {
    const path = this.path(record.task_id, "json");
    writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  query(id: string): Record {
    const live = this.running.get(id);
    if (live) return { ...live.record };
    const record = JSON.parse(readFileSync(this.path(id, "json"), "utf8")) as Record;
    if (!terminal(record.status)) {
      record.status = "lost";
      record.error = "The owning Pi runtime ended before recording completion; this task cannot be reattached.";
      this.save(record);
    }
    return record;
  }
  async run(cwd: string, args: { command: string; timeout?: number; run_in_background?: boolean }, signal: AbortSignal | undefined, started: (id: string) => void, completed: (id: string) => void) {
    signal?.throwIfAborted();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const fd = openSync(this.path(id, "output"), "wx", 0o600);
    const record: Record = { task_id: id, command: args.command, cwd, status: "running", created_at: new Date().toISOString() };
    try { this.save(record); started(id); } catch (error) { closeSync(fd); throw error; }
    const task: Running = { record, controller: new AbortController(), events: new EventEmitter(), done: Promise.resolve(), background: args.run_in_background === true };
    this.running.set(id, task);
    let storageError: Error | undefined;
    const tool = createBashTool(cwd, { operations: { exec: async (command, directory, options) => {
      const exit = await this.operations.exec(command, directory, { ...options, onData: data => {
        try {
          let offset = 0;
          while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
          options.onData(data);
          task.events.emit("change");
        } catch (error) {
          storageError = error instanceof Error ? error : new Error(String(error));
          task.controller.abort();
        }
      } });
      record.exit_code = exit.exitCode;
      return exit;
    } } });
    const abort = () => { record.status = "stopping"; task.controller.abort(); };
    // Explicit background tasks belong to the runtime, not the launching turn.
    if (!task.background) signal?.addEventListener("abort", abort, { once: true });
    const timeout = task.background ? backgroundTimeout(args.timeout) : foregroundTimeout(args.timeout);
    task.done = (async () => {
      try {
        task.output = await tool.execute(id, { command: args.command, timeout }, task.controller.signal);
        record.status = "succeeded";
      } catch (error) {
        task.error = storageError ?? (error instanceof Error ? error : new Error(String(error)));
        record.status = storageError ? "failed" : task.controller.signal.aborted ? "canceled" : "failed";
        record.error = task.error.message;
      } finally {
        signal?.removeEventListener("abort", abort);
        closeSync(fd);
        record.finished_at = new Date().toISOString();
        try { this.save(record); } catch (error) {
          task.error = new Error(`Cannot save task status: ${error}`);
          record.status = "failed";
          record.error = task.error.message;
        }
        task.events.emit("change");
        if (task.background) completed(id);
      }
    })();
    if (!task.background) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([task.done, new Promise<void>(resolve => { timer = setTimeout(resolve, this.yieldMs); })]);
      } finally { clearTimeout(timer); }
      signal?.removeEventListener("abort", abort);
      if (terminal(record.status)) {
        if (task.error) throw task.error;
        return task.output!;
      }
      signal?.throwIfAborted();
      task.background = true;
    }
    return result({ task_id: id, status: args.run_in_background ? "started" : "auto_promoted", message: "The command is running in the background. Do not rerun it. Use task_output to read output; completion will notify the owning conversation." });
  }
  async output(id: string, offset: number | undefined, waitMs = 0, signal?: AbortSignal, sessionId = "") {
    signal?.throwIfAborted();
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error("offset must be a non-negative byte count");
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error("wait_ms must be a non-negative integer");
    const cursor = JSON.stringify([sessionId, id]);
    const start = offset ?? this.cursors.get(cursor) ?? 0;
    const file = await open(this.path(id, "output"), "r");
    try {
      const task = this.running.get(id);
      if (task && !terminal(task.record.status) && (await file.stat()).size <= start && waitMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => { clearTimeout(timer); task.events.removeListener("change", finish); signal?.removeEventListener("abort", abort); resolve(); };
          const abort = () => { finish(); reject(signal?.reason ?? new Error("Aborted")); };
          const timer = setTimeout(finish, Math.min(waitMs, 30_000));
          task.events.once("change", finish);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          else if (terminal(task.record.status)) finish();
          else void file.stat().then(stat => { if (stat.size > start) finish(); }, abort);
        });
      }
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(50 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const next = start + bytesRead;
      if (offset === undefined) this.cursors.set(cursor, next);
      return { task_id: id, status: this.query(id).status, output: buffer.subarray(0, bytesRead).toString("utf8"), next_offset: next };
    } finally { await file.close(); }
  }
  async stop(id: string, reason?: string) {
    const task = this.running.get(id);
    if (task && !terminal(task.record.status)) {
      task.record.status = "stopping";
      task.record.reason = reason;
      task.controller.abort();
      await task.done;
    }
    return this.query(id);
  }
  async shutdown() {
    await Promise.all([...this.running.keys()].map(id => this.stop(id, "Pi runtime shutdown")));
  }
}

export function registerTaskTools(pi: ExtensionAPI, tasks = new Tasks()) {
  let current: ExtensionContext | undefined;
  let shuttingDown = false;
  let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  const notifications = new Set<string>();
  const ids = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === taskKey ? [entry.data as string] : []);
  function flush() {
    if (!current || shuttingDown || !minimaxEnabled(current)) return;
    if (!notifications.size) return;
    // sendMessage(triggerTurn) can start a run during compaction. Wait for the
    // runtime to become idle instead of racing its history replacement.
    if (!current.isIdle()) {
      notificationTimer ??= setTimeout(() => { notificationTimer = undefined; flush(); }, 50);
      notificationTimer.unref();
      return;
    }
    const owned = new Set(ids(current));
    for (const id of notifications) {
      if (!owned.has(id)) continue;
      notifications.delete(id);
      pi.sendMessage({ customType: "minimax-task-completed", content: `Background Bash task ${id} is ${tasks.query(id).status}. Use task_output to inspect the result before claiming success.`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
    }
  }
  for (const event of ["session_start", "session_switch", "session_fork", "session_tree", "before_agent_start"] as const) pi.on(event, (_event, ctx) => { current = ctx; flush(); });
  pi.events.on("rework:minimax-changed", (ctx: ExtensionContext) => { current = ctx; flush(); });
  pi.on("session_shutdown", async () => { shuttingDown = true; clearTimeout(notificationTimer); await tasks.shutdown(); });
  const check = (ctx: ExtensionContext, id?: string) => {
    if (!minimaxEnabled(ctx)) throw new Error("Enable /minimax before using this tool");
    if (id && !ids(ctx).includes(id)) throw new Error("Task ID is not on this session branch");
  };
  pi.registerTool({
    name: "bash", label: "Bash", renderCall: renderCommandCall, renderResult,
    description: "MiniMax mode only. Execute Bash in the current working directory. Foreground defaults to 120 seconds (maximum 300); after 15 seconds the same process returns a background task ID, retaining its deadline. run_in_background starts a managed task immediately. Do not rerun a returned task; use task_query, task_output, or task_stop. Output is bounded to 2000 lines or 50KB; full output is saved.",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ description: "Timeout in seconds; foreground defaults to 120, non-positive values use 120, maximum 300. Explicit background defaults to 1800 seconds; positive timeouts are capped at 2147483.647. Expiry kills the process tree." })), run_in_background: Type.Optional(Type.Boolean()) }),
    async execute(_id, args, signal, _update, ctx) {
      check(ctx); current = ctx;
      return tasks.run(ctx.cwd, args, signal, id => pi.appendEntry(taskKey, id), id => { notifications.add(id); flush(); });
    },
  });
  const definitions = [
    { name: "task_query", description: "Query background tasks on this session branch. Omit task_id to list tasks; pass task_id to get one. status filters the list.", parameters: Type.Object({ task_id: Type.Optional(Type.String()), status: Type.Optional(Type.Union(taskStatuses.map(status => Type.Literal(status)))) }),
      run: async (args: { task_id?: string; status?: Status }, _signal: AbortSignal | undefined, ctx: ExtensionContext) => args.task_id ? tasks.query(args.task_id) : ids(ctx).map(id => tasks.query(id)).filter(task => !args.status || task.status === args.status) },
    { name: "task_output", description: "Read output from a background task. Completion automatically notifies and resumes the owning conversation; do not poll frequently. Omit offset consistently for an automatic cursor; explicit offsets do not advance it. wait_ms waits for new output or completion, not a minimum polling interval. Waiting does not stop the task.", parameters: Type.Object({ task_id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset, not a page number. Use next_offset for incremental reads; 0 replays existing output." })), wait_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Defaults to 0. Values above 30000 are accepted and capped at 30000 ms." })) }),
      run: (args: { task_id: string; offset?: number; wait_ms?: number }, signal: AbortSignal | undefined, ctx: ExtensionContext) => tasks.output(args.task_id, args.offset, args.wait_ms, signal, ctx.sessionManager.getSessionId()) },
    { name: "task_stop", description: "Stop a background task by task_id, killing its process tree. Finished tasks are unchanged.", parameters: Type.Object({ task_id: Type.String(), reason: Type.Optional(Type.String()) }),
      run: (args: { task_id: string; reason?: string }) => tasks.stop(args.task_id, args.reason) },
  ];
  for (const definition of definitions) pi.registerTool({
    name: definition.name, label: definition.name, description: `MiniMax mode only. ${definition.description}`, parameters: definition.parameters,
    renderCall: toolCall(definition.name), renderResult,
    async execute(_id, args, signal, _update, ctx) {
      check(ctx, args.task_id); signal?.throwIfAborted();
      return result(await definition.run(args as never, signal, ctx));
    },
  });
}
