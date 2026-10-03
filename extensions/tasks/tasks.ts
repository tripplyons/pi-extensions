import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Type } from "typebox";
import { getAgentDir, createBashTool, createLocalBashOperations, type BashOperations, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { result } from "../../lib/common.ts";
import { renderCall as renderCommandCall } from "./command-preview.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";

export const taskKey = "pi:minimax-task";
export const watchKey = "pi:task-watch";
export type Watch = { task_id: string; enabled: boolean; interval_seconds: number; expected_seconds?: number; silence_seconds?: number };
export const taskStatuses = ["queued", "running", "stopping", "succeeded", "failed", "canceled", "lost"] as const;
type Status = typeof taskStatuses[number];
type Record = { task_id: string; command: string; cwd: string; status: Status; created_at: string; finished_at?: string; error?: string; exit_code?: number | null; reason?: string; deadline_at?: string; last_output_at?: string };
type Running = { record: Record; controller: AbortController; events: EventEmitter; done: Promise<void>; output?: Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>; background: boolean; error?: Error };
export function foregroundTimeout(timeout?: number) {
  return timeout === undefined || !Number.isFinite(timeout) || timeout <= 0 ? 120 : Math.min(timeout, 300);
}
export function backgroundTimeout(timeout?: number) {
  return timeout === undefined || !Number.isFinite(timeout) || timeout <= 0 ? 1800 : Math.min(timeout, 2147483.647);
}
const terminal = (status: Status) => !["queued", "running", "stopping"].includes(status);

function outputLength(buffer: Buffer, unfinished: boolean) {
  let end = buffer.length;
  for (let i = 0, lines = 0; i < end; i++) {
    if (buffer[i] === 10 && ++lines === 2000) { end = i + 1; break; }
  }
  if (!unfinished || end < buffer.length) return end;
  // Keep an incomplete UTF-8 character for the next byte-offset read.
  let lead = end - 1;
  while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead--;
  if (lead < 0) return end;
  const byte = buffer[lead];
  const width = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;
  return end - lead < width ? lead : end;
}

export function watchWarnings(progress: { elapsed_seconds: number; output_silence_seconds: number }, watch: Watch) {
  const warnings: string[] = [];
  if (watch.expected_seconds !== undefined && progress.elapsed_seconds >= watch.expected_seconds) warnings.push("expected duration exceeded");
  if (watch.silence_seconds !== undefined && progress.output_silence_seconds >= watch.silence_seconds) warnings.push("output silent");
  return warnings;
}

export class Tasks {
  private running = new Map<string, Running>();
  private cursors = new Map<string, number>();
  private completion = new Map<string, "pending" | "observed" | "notified">();
  private completions = new EventEmitter();
  onComplete(listener: (id: string) => void) {
    this.completions.on("complete", listener);
    return () => { this.completions.off("complete", listener); };
  }
  pending(ids: string[]) { return ids.filter(id => this.completion.get(id) === "pending"); }
  acknowledge(id: string, state: "observed" | "notified") { this.completion.set(id, state); }
  constructor(readonly root = join(getAgentDir(), "minimax", "tasks"), private operations: BashOperations = createLocalBashOperations(), private yieldMs = 15_000) {}
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
    const timeout = args.run_in_background ? backgroundTimeout(args.timeout) : foregroundTimeout(args.timeout);
    const record: Record = { task_id: id, command: args.command, cwd, status: "running", created_at: new Date().toISOString(), deadline_at: new Date(Date.now() + timeout * 1000).toISOString() };
    try { this.save(record); started(id); } catch (error) { closeSync(fd); throw error; }
    const task: Running = { record, controller: new AbortController(), events: new EventEmitter(), done: Promise.resolve(), background: args.run_in_background === true };
    this.running.set(id, task);
    let storageError: Error | undefined;
    const tool = createBashTool(cwd, { operations: { exec: async (command, directory, options) => {
      const exit = await this.operations.exec(command, directory, { ...options, onData: data => {
        try {
          let offset = 0;
          while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
          if (data.length) record.last_output_at = new Date().toISOString();
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
    task.done = (async () => {
      try {
        task.output = await tool.execute(id, { command: args.command, timeout }, task.controller.signal);
        record.status = record.exit_code === 0 ? "succeeded" : "failed";
        if (record.status === "failed") record.error = `Command exited with code ${record.exit_code}`;
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
        if (task.background) {
          this.completion.set(id, "pending");
          completed(id);
          this.completions.emit("complete", id);
        }
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
    return result({ task_id: id, status: args.run_in_background ? "started" : "auto_promoted", message: "The command is running in the background. Do not rerun it. Use task_output to read output; unobserved completion will notify the owning conversation." });
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
      const status = this.query(id).status;
      const length = outputLength(buffer.subarray(0, bytesRead), bytesRead === buffer.length || !terminal(status));
      const next = start + length;
      if (offset === undefined) this.cursors.set(cursor, next);
      return { task_id: id, status, output: buffer.subarray(0, length).toString("utf8"), next_offset: next };
    } finally { await file.close(); }
  }
  async progress(id: string, now = Date.now()) {
    const record = this.query(id), metadata = await stat(this.path(id, "output"));
    const lastOutput = record.last_output_at ?? (metadata.size ? new Date(metadata.mtimeMs).toISOString() : record.created_at);
    const file = await open(this.path(id, "output"), "r");
    let recent = "";
    try {
      const offset = Math.max(0, metadata.size - 2048), buffer = Buffer.alloc(Math.min(metadata.size, 2048));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      let start = 0;
      if (offset) while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
      recent = buffer.subarray(start, bytesRead).toString("utf8").split("\n").slice(-5).join("\n");
    } finally { await file.close(); }
    return { ...record, elapsed_seconds: Math.max(0, Math.floor((now - Date.parse(record.created_at)) / 1000)),
      output_bytes: metadata.size, output_silence_seconds: Math.max(0, Math.floor((now - Date.parse(lastOutput)) / 1000)),
      deadline_remaining_seconds: record.deadline_at ? Math.max(0, Math.ceil((Date.parse(record.deadline_at) - now) / 1000)) : null, recent_output: recent };
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

// Session replacement invalidates extension contexts, not managed processes.
const poolKey = Symbol.for("tripp.pi.background-tasks");
const pools = globalThis as unknown as { [key: symbol]: Map<string, Tasks> };
function taskRunner() {
  const pool = pools[poolKey] ??= new Map();
  const dir = getAgentDir();
  let tasks = pool.get(dir);
  if (!tasks) { tasks = new Tasks(); pool.set(dir, tasks); }
  // Reload the methods, but keep the process handles, cursors and notifications.
  else Object.setPrototypeOf(tasks, Tasks.prototype);
  return tasks;
}

export function registerTaskTools(pi: ExtensionAPI, tasks = taskRunner()) {
  let current: ExtensionContext | undefined;
  let shuttingDown = false;
  let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  const notifications = new Set<string>();
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let watching = false;
  const watches = new Map<string, { config: Watch; due: number; warnings: string[] }>();
  function restoreWatches(ctx: ExtensionContext) {
    const configs = new Map<string, Watch>();
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === watchKey) {
      const config = entry.data as Watch; configs.set(config.task_id, config);
    }
    const owned = new Set(ids(ctx));
    for (const [id, config] of configs) {
      if (!owned.has(id) || !config.enabled || terminal(tasks.query(id).status)) { watches.delete(id); continue; }
      const previous = watches.get(id);
      if (!previous || JSON.stringify(previous.config) !== JSON.stringify(config)) watches.set(id, { config, due: Date.now() + config.interval_seconds * 1000, warnings: [] });
    }
    for (const id of watches.keys()) if (!configs.has(id) || !owned.has(id)) watches.delete(id);
    if (watches.size && !watchTimer) { watchTimer = setInterval(() => void watchProgress(), 1000); watchTimer.unref(); }
    if (!watches.size) { clearInterval(watchTimer); watchTimer = undefined; }
  }
  async function watchProgress() {
    const ctx = current;
    if (!ctx || shuttingDown || watching || !ctx.isIdle()) return;
    watching = true;
    try {
      for (const [id, watch] of watches) {
        if (Date.now() < watch.due) continue;
        if (!ids(ctx).includes(id) || terminal(tasks.query(id).status)) { watches.delete(id); continue; }
        const progress = await tasks.progress(id);
        if (current !== ctx || shuttingDown) return;
        const warnings = watchWarnings(progress, watch.config);
        const investigate = warnings.some(warning => !watch.warnings.includes(warning));
        watch.warnings = warnings; watch.due = Date.now() + watch.config.interval_seconds * 1000;
        const expectation = watch.config.expected_seconds === undefined ? "Expected duration: not set." : `Expected duration: ${watch.config.expected_seconds}s; expected time remaining: ${Math.max(0, watch.config.expected_seconds - progress.elapsed_seconds)}s (not a measured ETA).`;
        pi.sendMessage({ customType: "pi-task-progress", content: `Background Bash task ${id}: ${progress.status}. Elapsed ${progress.elapsed_seconds}s; ${progress.output_bytes} output bytes; output silence ${progress.output_silence_seconds}s; deadline remaining ${progress.deadline_remaining_seconds ?? "unknown"}s. ${expectation}\nRecent output:\n${progress.recent_output || "(none)"}${warnings.length ? `\nWarnings: ${warnings.join(", ")}. Investigate the process and recent output instead of just waiting. Update the user with progress and an evidence-based ETA; do not invent one.` : ""}`, display: true, details: { ...progress, warnings } }, { triggerTurn: investigate, deliverAs: "steer" });
      }
      if (!watches.size) { clearInterval(watchTimer); watchTimer = undefined; }
    } catch (error) { ctx.ui.setStatus("task-watch-error", String(error)); }
    finally { watching = false; }
  }
  const detach = tasks.onComplete(id => { notifications.add(id); flush(); });
  const ids = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === taskKey ? [entry.data as string] : []);
  function flush() {
    if (!current || shuttingDown) return;
    if (!notifications.size) return;
    const owned = new Set(ids(current));
    const pending = [...notifications].filter(id => owned.has(id));
    if (!pending.length) return;
    // sendMessage(triggerTurn) can start a run during compaction. Wait for the
    // runtime to become idle instead of racing its history replacement.
    if (!current.isIdle()) {
      notificationTimer ??= setTimeout(() => { notificationTimer = undefined; flush(); }, 50);
      notificationTimer.unref();
      return;
    }
    const content = pending.map(id => `Background Bash task ${id} is ${tasks.query(id).status}.`).join("\n");
    for (const id of pending) { notifications.delete(id); tasks.acknowledge(id, "notified"); }
    // One steering message wakes the conversation for the whole batch.
    pi.sendMessage({ customType: "pi-task-completed", content: `${content}\nUse task_output to inspect the results before claiming success.`, display: true }, { triggerTurn: true, deliverAs: "steer" });
  }
  const load = (_event: unknown, ctx: ExtensionContext) => {
    current = ctx;
    restoreWatches(ctx);
    for (const id of tasks.pending(ids(ctx))) notifications.add(id);
    flush();
  };
  pi.on("session_start", load);
  pi.on("session_tree", load);
  pi.on("before_agent_start", load);
  pi.on("session_shutdown", async event => {
    shuttingDown = true; current = undefined; clearTimeout(notificationTimer); clearInterval(watchTimer); detach();
    if (event.reason && event.reason !== "quit") return;
    await tasks.shutdown();
    const pool = pools[poolKey];
    if (pool) {
      await Promise.all([...pool.values()].filter(runner => runner !== tasks).map(runner => runner.shutdown()));
      pool.clear();
    }
  });
  const check = (ctx: ExtensionContext, id?: string) => {
    if (id && !ids(ctx).includes(id)) throw new Error("Task ID is not on this session branch");
  };
  pi.registerTool({
    name: "bash", label: "Bash", renderCall: renderCommandCall, renderResult,
    description: "Execute Bash in the current working directory. Foreground defaults to 120 seconds (maximum 300); after 15 seconds the same process returns a background task ID, retaining its deadline. run_in_background starts a managed task immediately. Do not rerun a returned task; use task_query, task_output, or task_stop. Output is bounded to 2000 lines or 50KB; full output is saved.",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ description: "Timeout in seconds; foreground defaults to 120, non-positive values use 120, maximum 300. Explicit background defaults to 1800 seconds; positive timeouts are capped at 2147483.647. Expiry kills the process tree." })), run_in_background: Type.Optional(Type.Boolean()) }),
    async execute(_id, args, signal, _update, ctx) {
      check(ctx); current = ctx;
      return tasks.run(ctx.cwd, args, signal, id => pi.appendEntry(taskKey, id), () => {});
    },
  });
  pi.registerTool({ name: "task_watch", label: "task_watch", renderCall: toolCall("task_watch"), renderResult,
    description: "Opt in to progress reports for a task on this branch. Reports include elapsed time, bounded recent output, output silence, and remaining deadline without moving output cursors. Expected-duration or silence warnings wake the conversation once per warning episode to investigate. Reports wait until Pi is idle. Disable with enabled=false. Watching never extends a deadline or stops a process.",
    parameters: Type.Object({ task_id: Type.String(), enabled: Type.Optional(Type.Boolean()), interval_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })), expected_seconds: Type.Optional(Type.Integer({ minimum: 1 })), silence_seconds: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id, args, signal, _update, ctx) {
      check(ctx, args.task_id); signal?.throwIfAborted(); current = ctx;
      const enabled = args.enabled ?? true;
      if (enabled && terminal(tasks.query(args.task_id).status)) throw new Error("Task is already finished; inspect its output instead");
      const config: Watch = { ...args, enabled, interval_seconds: args.interval_seconds ?? 300 };
      pi.appendEntry(watchKey, config); restoreWatches(ctx);
      return result({ watch: config, progress: await tasks.progress(args.task_id) });
    },
  });
  const definitions = [
    { name: "task_query", description: "Query background tasks on this session branch. Omit task_id to list tasks; pass task_id to get one. status filters the list.", parameters: Type.Object({ task_id: Type.Optional(Type.String()), status: Type.Optional(Type.Union(taskStatuses.map(status => Type.Literal(status)))) }),
      run: async (args: { task_id?: string; status?: Status }, _signal: AbortSignal | undefined, ctx: ExtensionContext) => args.task_id ? tasks.query(args.task_id) : ids(ctx).map(id => tasks.query(id)).filter(task => !args.status || task.status === args.status) },
    { name: "task_output", description: "Read output from a background task. Unobserved completion automatically notifies and resumes the owning conversation; do not poll frequently. Returning terminal status acknowledges completion without discarding unread output. Omit offset consistently for an automatic cursor; explicit offsets do not advance it. wait_ms waits for new output or completion, not a minimum polling interval. Waiting does not stop the task.", parameters: Type.Object({ task_id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset, not a page number. Use next_offset for incremental reads; 0 replays existing output." })), wait_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Defaults to 0. Values above 30000 are accepted and capped at 30000 ms." })) }),
      run: (args: { task_id: string; offset?: number; wait_ms?: number }, signal: AbortSignal | undefined, ctx: ExtensionContext) => tasks.output(args.task_id, args.offset, args.wait_ms, signal, ctx.sessionManager.getSessionId()) },
    { name: "task_stop", description: "Stop a background task by task_id, killing its process tree. Finished tasks are unchanged.", parameters: Type.Object({ task_id: Type.String(), reason: Type.Optional(Type.String()) }),
      run: (args: { task_id: string; reason?: string }) => tasks.stop(args.task_id, args.reason) },
  ];
  for (const definition of definitions) pi.registerTool({
    name: definition.name, label: definition.name, description: definition.description, parameters: definition.parameters,
    renderCall: toolCall(definition.name), renderResult,
    async execute(_id, args, signal, _update, ctx) {
      check(ctx, args.task_id); signal?.throwIfAborted();
      const value = await definition.run(args as never, signal, ctx);
      signal?.throwIfAborted();
      // A returned terminal status already tells the agent the task finished.
      // Use the returned snapshot, not a fresh query: a running read must not
      // swallow a completion that races the tool response.
      for (const task of Array.isArray(value) ? value : [value]) {
        if (terminal(task.status)) { notifications.delete(task.task_id); tasks.acknowledge(task.task_id, "observed"); }
      }
      return result(value);
    },
  });
}
