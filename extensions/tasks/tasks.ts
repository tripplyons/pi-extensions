import { randomUUID } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Type } from "typebox";
import { getAgentDir, createBashTool, createLocalBashOperations, type BashOperations, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { result } from "../../lib/common.ts";
import { renderCall as renderCommandCall } from "./command-preview.ts";
import { renderResult, toolCall } from "../../lib/tool-preview.ts";

export const taskKey = "pi:minimax-task";
export const taskStatuses = ["queued", "running", "stopping", "succeeded", "failed", "canceled", "lost"] as const;
type Status = typeof taskStatuses[number];
type Record = { task_id: string; command: string; cwd: string; status: Status; created_at: string; finished_at?: string; error?: string; exit_code?: number | null; reason?: string; deadline_at?: string; last_output_at?: string; pipefail?: boolean };
type Running = { record: Record; controller: AbortController; done: Promise<void>; output?: Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>; background: boolean; error?: Error };
export const promotionMs = 5_000;
export const maxSleepSeconds = 1800;
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

async function fileProgress(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Not a regular file");
    const offset = Math.max(0, metadata.size - 2048), buffer = Buffer.alloc(Math.min(metadata.size, 2048));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    let start = 0;
    if (offset) while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
    const end = outputLength(buffer.subarray(0, bytesRead), true);
    return { bytes: metadata.size, modified_at: new Date(metadata.mtimeMs).toISOString(),
      recent_output: buffer.subarray(start, end).toString("utf8").split("\n").slice(-5).join("\n") };
  } finally { await file.close(); }
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
  background(ids: string[]) {
    return ids.flatMap(id => {
      const task = this.running.get(id);
      return task?.background && !terminal(task.record.status)
        ? [{ taskId: id, kind: "command" as const, description: task.record.command.slice(0, 1000) }]
        : [];
    });
  }
  pending(ids: string[]) { return ids.filter(id => this.completion.get(id) === "pending"); }
  acknowledge(id: string, state: "observed" | "notified") { this.completion.set(id, state); }
  /** Whether this session read the task's output through its automatic cursor, up to the end. */
  fullyRead(id: string, sessionId: string) {
    const cursor = this.cursors.get(JSON.stringify([sessionId, id]));
    try { return cursor !== undefined && cursor >= statSync(this.path(id, "output")).size; } catch { return false; }
  }
  /** Final status with its exit code; a zero-exit pipeline may hide an earlier failure. */
  completionNotice(id: string) {
    const task = this.query(id);
    const exit = typeof task.exit_code === "number" ? ` (exit ${task.exit_code}${task.exit_code === 0 && task.command.includes("|") && !task.pipefail ? "; without pipefail, a pipeline reports only its last command's exit code" : ""})` : "";
    return `Background Bash task ${id} is ${task.status}${exit}.`;
  }
  constructor(readonly root = join(getAgentDir(), "minimax", "tasks"), private operations: BashOperations = createLocalBashOperations(), private yieldMs = promotionMs) {}
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
  private async foregroundResult(task: Running) {
    const native = task.output!;
    const truncation = native.details?.truncation;
    if (!truncation?.truncated || truncation.content || truncation.outputBytes) return native;
    // Pi can discard a trimmed long final line at its trailing newline. Read
    // our captured prefix only for that empty-preview defect, not normal tails.
    const preview = await this.output(task.record.task_id, 0);
    if (!preview.output) return native;
    const outputLines = preview.output.split("\n").length - (preview.output.endsWith("\n") ? 1 : 0);
    const lastLinePartial = !preview.output.endsWith("\n") && preview.next_offset < truncation.totalBytes;
    const limit = outputLines >= 2000 ? "lines" : "bytes";
    const notice = `[Recovered leading preview: ${preview.next_offset} bytes, ${outputLines} of ${truncation.totalLines} lines${lastLinePartial ? "; last line is partial" : ""}. Full output: ${native.details?.fullOutputPath}]`;
    const status = task.record.exit_code ? `\n\nCommand exited with code ${task.record.exit_code}` : "";
    return {
      ...native,
      content: [{ type: "text" as const, text: `${preview.output}\n\n${notice}${status}` }],
      details: { ...native.details, truncation: { ...truncation, content: preview.output,
        truncatedBy: limit as "lines" | "bytes", outputLines, outputBytes: preview.next_offset, lastLinePartial } },
    };
  }
  async run(cwd: string, args: { command: string; timeout?: number; run_in_background?: boolean; pipefail?: boolean }, signal: AbortSignal | undefined, started: (id: string) => void, completed: (id: string) => void, steering?: AbortSignal) {
    signal?.throwIfAborted();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const fd = openSync(this.path(id, "output"), "wx", 0o600);
    // Every command can outlive its first five seconds, so all share one deadline rule.
    const timeout = backgroundTimeout(args.timeout);
    const record: Record = { task_id: id, command: args.command, cwd, status: "running", created_at: new Date().toISOString(), deadline_at: new Date(Date.now() + timeout * 1000).toISOString(), ...(args.pipefail ? { pipefail: true } : {}) };
    try { this.save(record); started(id); } catch (error) { closeSync(fd); throw error; }
    const task: Running = { record, controller: new AbortController(), done: Promise.resolve(), background: args.run_in_background === true };
    this.running.set(id, task);
    let storageError: Error | undefined;
    const tool = createBashTool(cwd, { commandPrefix: args.pipefail ? "set -o pipefail" : undefined, operations: { exec: async (command, directory, options) => {
      const exit = await this.operations.exec(command, directory, { ...options, onData: data => {
        try {
          let offset = 0;
          while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
          if (data.length) record.last_output_at = new Date().toISOString();
          options.onData(data);
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
        if (task.background) {
          this.completion.set(id, "pending");
          completed(id);
          this.completions.emit("complete", id);
        }
      }
    })();
    if (!task.background) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let yieldWait: () => void = () => {};
      try {
        await Promise.race([task.done, new Promise<void>(resolve => {
          yieldWait = resolve;
          timer = setTimeout(resolve, this.yieldMs);
          steering?.addEventListener("abort", yieldWait, { once: true });
          if (steering?.aborted) yieldWait();
        })]);
      } finally {
        clearTimeout(timer);
        steering?.removeEventListener("abort", yieldWait);
      }
      signal?.removeEventListener("abort", abort);
      if (terminal(record.status)) {
        if (task.error) throw task.error;
        return this.foregroundResult(task);
      }
      signal?.throwIfAborted();
      task.background = true;
    }
    return result({ task_id: id, status: args.run_in_background ? "started" : "auto_promoted", message: "The command is running in the background. Do not rerun it. Use task_output to read output; unobserved completion will notify the owning conversation." });
  }
  async output(id: string, offset: number | undefined, signal?: AbortSignal, sessionId = "") {
    signal?.throwIfAborted();
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error("offset must be a non-negative byte count");
    const cursor = JSON.stringify([sessionId, id]);
    const start = offset ?? this.cursors.get(cursor) ?? 0;
    const file = await open(this.path(id, "output"), "r");
    try {
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
    const record = this.query(id), output = await fileProgress(this.path(id, "output"));
    const lastOutput = record.last_output_at ?? (output.bytes ? output.modified_at : record.created_at);
    // A finished task's clock stops at finished_at; its deadline no longer applies.
    const end = record.finished_at ? Date.parse(record.finished_at) : now;
    return { ...record, elapsed_seconds: Math.max(0, Math.floor((end - Date.parse(record.created_at)) / 1000)),
      output_bytes: output.bytes, output_silence_seconds: Math.max(0, Math.floor((end - Date.parse(lastOutput)) / 1000)),
      deadline_remaining_seconds: record.deadline_at && !record.finished_at ? Math.max(0, Math.ceil((Date.parse(record.deadline_at) - now) / 1000)) : null, recent_output: output.recent_output };
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
  // Steering releases only the current waits. It must not cancel their processes
  // or make later waits yield to a message Pi has already delivered.
  type Wake = "steering" | "swarm" | "task";
  const sleepers = new Set<(reason: Wake) => void>();
  let steering = new AbortController();
  const releaseWaits = (reason: "steering" | "swarm") => {
    const waiting = steering;
    steering = new AbortController();
    waiting.abort();
    for (const wake of [...sleepers]) wake(reason);
  };
  pi.on("input", event => {
    if (event.streamingBehavior === "steer") releaseWaits("steering");
    return { action: "continue" };
  });
  // Swarm messages, alerts and check-ins use sendMessage, which bypasses Pi's
  // user-input hook. Delivery is already queued as steering before this event.
  const detachSwarm = pi.events.on("pi:swarm-activity", () => releaseWaits("swarm"));
  const detach = tasks.onComplete(id => {
    publishBackground();
    notifications.add(id);
    // A sleeping conversation receives the notice in its sleep result instead of a new turn.
    if (sleepers.size && current && ids(current).includes(id)) { for (const wake of [...sleepers]) wake("task"); return; }
    flush();
  });
  const ids = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === taskKey ? [entry.data as string] : []);
  // Full branch-scoped snapshots let hosts restore state after either extension reloads.
  function publishBackground() {
    if (!current || shuttingDown) return;
    pi.events.emit("t3:background-tasks", {
      sessionFile: current.sessionManager.getSessionFile(),
      source: "tasks",
      tasks: tasks.background(ids(current)),
    });
  }
  const detachBackground = pi.events.on("t3:background-tasks-request", publishBackground);
  function flush() {
    if (!current || shuttingDown) return;
    if (!notifications.size) return;
    const owned = new Set(ids(current));
    const owner = current.sessionManager.getSessionId();
    const finished = [...notifications].filter(id => owned.has(id));
    // A conversation that already read all output needs the final status, not a new turn.
    const read = finished.filter(id => tasks.fullyRead(id, owner));
    if (read.length) {
      for (const id of read) { notifications.delete(id); tasks.acknowledge(id, "notified"); }
      pi.sendMessage({ customType: "pi-task-completed", content: `${read.map(id => tasks.completionNotice(id)).join("\n")}\nIts output was already read with task_output.`, display: true }, { deliverAs: "nextTurn" });
    }
    const pending = finished.filter(id => !read.includes(id));
    if (!pending.length) return;
    // sendMessage(triggerTurn) can start a run during compaction. Wait for the
    // runtime to become idle instead of racing its history replacement.
    if (!current.isIdle()) {
      notificationTimer ??= setTimeout(() => { notificationTimer = undefined; flush(); }, 50);
      notificationTimer.unref();
      return;
    }
    const content = pending.map(id => tasks.completionNotice(id)).join("\n");
    for (const id of pending) { notifications.delete(id); tasks.acknowledge(id, "notified"); }
    // One steering message wakes the conversation for the whole batch.
    pi.sendMessage({ customType: "pi-task-completed", content: `${content}\nUse task_output to inspect the results before claiming success.`, display: true }, { triggerTurn: true, deliverAs: "steer" });
  }
  const load = (_event: unknown, ctx: ExtensionContext) => {
    current = ctx;
    publishBackground();
    for (const id of tasks.pending(ids(ctx))) notifications.add(id);
    flush();
  };
  pi.on("session_start", load);
  pi.on("session_tree", load);
  pi.on("before_agent_start", load);
  pi.on("session_shutdown", async event => {
    shuttingDown = true; current = undefined; clearTimeout(notificationTimer); detach(); detachBackground(); detachSwarm();
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
    description: "Execute Bash in the current working directory. A command still running after 5 seconds returns a background task ID for the same process; user steering or a swarm message returns it sooner. Do not rerun a returned task; call sleep to wait for it, then task_output to read it. run_in_background returns the task ID immediately. Every command has a 1800-second default deadline; set timeout for a longer one. Output is bounded to 2000 lines or 50KB; full output is saved. pipefail=true enables Bash pipeline failure detection without enabling errexit. Stopping or timing out a local process does not guarantee that remote work stops.",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ description: "Deadline in seconds, default 1800. Non-positive values use 1800; values are capped at 2147483.647. Background promotion keeps the deadline. Expiry kills the process tree." })), run_in_background: Type.Optional(Type.Boolean({ description: "Return the task ID immediately instead of waiting up to 5 seconds." })), pipefail: Type.Optional(Type.Boolean({ description: "Enable set -o pipefail: a pipeline returns the rightmost nonzero exit status, or zero if all commands succeed. Off by default; does not enable set -e or report each command's status." })) }),
    async execute(_id, args, signal, _update, ctx) {
      check(ctx); current = ctx;
      try {
        return await tasks.run(ctx.cwd, args, signal, id => pi.appendEntry(taskKey, id), () => {}, steering.signal);
      } finally { publishBackground(); }
    },
  });
  pi.registerTool({ name: "sleep", label: "sleep", renderCall: toolCall("sleep"), renderResult,
    description: `Wait without polling. Returns early when the user steers, a swarm message, alert or check-in arrives, or a background task on this branch finishes; otherwise returns after seconds (1-${maxSleepSeconds}) with a progress snapshot of running tasks. The result names the wake reason and includes completion notices, which replace a separate completion turn. Read finished output with task_output before claiming success. Sleeping never stops or extends a task. Silence in a snapshot does not prove that a process is stuck.`,
    parameters: Type.Object({ seconds: Type.Integer({ minimum: 1, maximum: maxSleepSeconds, description: "Longest wait in seconds. The call returns sooner on a wake event." }) }),
    async execute(_id, args, signal, _update, ctx) {
      check(ctx); signal?.throwIfAborted(); current = ctx;
      if (!Number.isSafeInteger(args.seconds) || args.seconds < 1 || args.seconds > maxSleepSeconds) throw new Error(`seconds must be an integer between 1 and ${maxSleepSeconds}`);
      const started = Date.now();
      const ready = () => { const owned = new Set(ids(ctx)); return [...notifications].filter(id => owned.has(id)); };
      let reason: Wake | "timeout" = "task";
      if (!ready().length) {
        try {
          reason = await new Promise<Wake | "timeout">((resolve, reject) => {
            const done = () => { clearTimeout(timer); sleepers.delete(finish); signal?.removeEventListener("abort", abort); };
            const finish = (value: Wake | "timeout") => { done(); resolve(value); };
            const abort = () => { done(); reject(signal?.reason ?? new Error("Aborted")); };
            const timer = setTimeout(() => finish("timeout"), args.seconds * 1000);
            sleepers.add(finish);
            signal?.addEventListener("abort", abort, { once: true });
          });
        } catch (error) {
          // Completions that arrived during a canceled sleep still need a notice.
          flush();
          throw error;
        }
      }
      const finished = ready();
      for (const id of finished) { notifications.delete(id); tasks.acknowledge(id, "notified"); }
      const completed = finished.map(id => {
        const task = tasks.query(id);
        return { task_id: id, status: task.status, exit_code: task.exit_code ?? null, notice: tasks.completionNotice(id) };
      });
      const running = reason !== "timeout" ? undefined : await Promise.all(tasks.background(ids(ctx)).map(async ({ taskId }) => {
        const { task_id, command, status, elapsed_seconds, output_bytes, output_silence_seconds, deadline_remaining_seconds, recent_output } = await tasks.progress(taskId);
        return { task_id, command: command.slice(0, 200), status, elapsed_seconds, output_bytes, output_silence_seconds, deadline_remaining_seconds, recent_output };
      }));
      const message = reason === "steering" ? "New user input is waiting. Read and handle it."
        : reason === "swarm" ? "A swarm message is waiting. Read and handle it."
        : reason === "task" ? "Use task_output to inspect the results before claiming success."
        : running?.length ? "Sleep finished. Report progress from the snapshot, or sleep again." : "Sleep finished. No background tasks are running on this branch.";
      return result({ woke: reason, slept_seconds: Math.round((Date.now() - started) / 100) / 10, completed, ...(running ? { running } : {}), message });
    },
  });
  const definitions = [
    { name: "task_query", description: "Query background tasks on this session branch. Omit task_id to list tasks; pass task_id to get one. status filters the list.", parameters: Type.Object({ task_id: Type.Optional(Type.String()), status: Type.Optional(Type.Union(taskStatuses.map(status => Type.Literal(status)))) }),
      run: async (args: { task_id?: string; status?: Status }, _signal: AbortSignal | undefined, ctx: ExtensionContext) => args.task_id ? tasks.query(args.task_id) : ids(ctx).map(id => tasks.query(id)).filter(task => !args.status || task.status === args.status) },
    { name: "task_output", description: "Read output from a background task without waiting. Call sleep to wait for output or completion instead of polling. Returning terminal status acknowledges completion without discarding unread output. Omit offset consistently for an automatic cursor; explicit offsets do not advance it.", parameters: Type.Object({ task_id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset, not a page number. Use next_offset for incremental reads; 0 replays existing output." })) }),
      run: (args: { task_id: string; offset?: number }, signal: AbortSignal | undefined, ctx: ExtensionContext) => tasks.output(args.task_id, args.offset, signal, ctx.sessionManager.getSessionId()) },
    { name: "task_stop", description: "Stop a background task by task_id, killing its local process tree. This does not guarantee that remote work stops; track remote IDs and verify remote cleanup separately. Finished tasks are unchanged.", parameters: Type.Object({ task_id: Type.String(), reason: Type.Optional(Type.String()) }),
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
