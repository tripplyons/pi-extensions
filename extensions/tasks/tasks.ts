import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
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
type Record = { task_id: string; command: string; cwd: string; status: Status; created_at: string; finished_at?: string; error?: string; exit_code?: number | null; reason?: string; deadline_at?: string; last_output_at?: string; pipefail?: boolean; stdin?: boolean };
type Running = { record: Record; controller: AbortController; done: Promise<void>; output?: Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>; background: boolean; error?: Error; stdinFd?: number };
export const promotionMs = 5_000;
export const maxSleepSeconds = 1800;
export const maxInputWaitSeconds = 60;
export function backgroundTimeout(timeout?: number) {
  return timeout === undefined || !Number.isFinite(timeout) || timeout <= 0 ? 1800 : Math.min(timeout, 2147483.647);
}
const terminal = (status: Status) => !["queued", "running", "stopping"].includes(status);
export const groupPollMs = 1_000;
/** A process group that outlived its command's shell, such as `nohup job &`. */
type Group = { pgid: number; exited_at?: string };

/** Whether any process is left in group `pgid`. EPERM means one exists. */
export function groupAlive(pgid: number) {
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

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
  /** The furthest byte each session has read of each task, by cursor or explicit offset. */
  private readTo = new Map<string, number>();
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
  /** Bytes of the task's output this session has not read yet. */
  unreadBytes(id: string, sessionId: string) {
    try { return Math.max(0, statSync(this.path(id, "output")).size - (this.readTo.get(JSON.stringify([sessionId, id])) ?? 0)); } catch { return 0; }
  }
  /** Final status with its exit code; a zero-exit pipeline may hide an earlier failure. */
  completionNotice(id: string) {
    const task = this.query(id);
    const exit = typeof task.exit_code === "number" ? ` (exit ${task.exit_code}${task.exit_code === 0 && task.command.includes("|") && !task.pipefail ? "; without pipefail, a pipeline reports only its last command's exit code" : ""})` : "";
    return `Background Bash task ${id} is ${task.status}${exit}.${this.groupNotice(id)}`;
  }
  private operations: BashOperations;
  private trackGroups: boolean;
  /** Test hook: whether a process group still has members. */
  alive = groupAlive;
  /**
   * `operations` replaces the local shell, which also turns off process-group
   * tracking unless `trackGroups` is set: tracking prefixes each command.
   */
  constructor(readonly root = join(getAgentDir(), "minimax", "tasks"), operations?: BashOperations, private yieldMs = promotionMs, trackGroups?: boolean) {
    this.operations = operations ?? createLocalBashOperations();
    this.trackGroups = trackGroups ?? !operations;
  }
  // Reloads swap the prototype of a live runner, so these fields may be missing.
  private get groups() { return (this as unknown as { _groups?: Map<string, Group> })._groups ??= new Map(); }
  private get groupEvents() { return (this as unknown as { _groupEvents?: EventEmitter })._groupEvents ??= new EventEmitter(); }
  /** Calls `listener` with the task ID when the last process its command left running exits. */
  onGroupExit(listener: (id: string) => void) {
    this.groupEvents.on("exit", listener);
    return () => { this.groupEvents.off("exit", listener); };
  }
  /** Process groups that commands in `ids` left running, with their state. */
  detachedGroups(ids: string[]) {
    return ids.flatMap(id => {
      const group = this.groups.get(id);
      return group ? [{ task_id: id, command: this.query(id).command.slice(0, 200), pgid: group.pgid, ...(group.exited_at ? { exited_at: group.exited_at } : {}) }] : [];
    });
  }
  /** Stops reporting an exited group. */
  forgetGroup(id: string) {
    if (this.groups.get(id)?.exited_at) this.groups.delete(id);
  }
  private groupNotice(id: string) {
    const group = this.groups.get(id);
    return group && !group.exited_at ? ` Processes it started in the background are still running (process group ${group.pgid}); sleep wakes when they all exit.` : "";
  }
  /** Starts watching the group the shell recorded in `file`, if processes outlived the shell. */
  private watchGroup(id: string, file: string) {
    let pgid: number;
    try { pgid = Number(readFileSync(file, "utf8")); rmSync(file, { force: true }); } catch { return; }
    if (!Number.isSafeInteger(pgid) || pgid <= 1 || !this.alive(pgid)) return;
    this.groups.set(id, { pgid });
    const self = this as unknown as { _groupTimer?: ReturnType<typeof setInterval> };
    if (self._groupTimer) return;
    self._groupTimer = setInterval(() => {
      let watching = false;
      for (const [taskId, group] of this.groups) {
        if (group.exited_at) continue;
        if (this.alive(group.pgid)) { watching = true; continue; }
        group.exited_at = new Date().toISOString();
        this.groupEvents.emit("exit", taskId);
      }
      if (!watching) { clearInterval(self._groupTimer); self._groupTimer = undefined; }
    }, groupPollMs);
    self._groupTimer.unref?.();
  }
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
  async run(cwd: string, args: { command: string; timeout?: number; run_in_background?: boolean; pipefail?: boolean; stdin?: boolean }, signal: AbortSignal | undefined, started: (id: string) => void, completed: (id: string) => void, steering?: AbortSignal) {
    signal?.throwIfAborted();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const fd = openSync(this.path(id, "output"), "wx", 0o600);
    // Every command can outlive its first five seconds, so all share one deadline rule.
    const timeout = backgroundTimeout(args.timeout);
    const record: Record = { task_id: id, command: args.command, cwd, status: "running", created_at: new Date().toISOString(), deadline_at: new Date(Date.now() + timeout * 1000).toISOString(), ...(args.pipefail ? { pipefail: true } : {}), ...(args.stdin ? { stdin: true } : {}) };
    // stdin=true connects the command to a FIFO. The runner holds it open read-write, so the
    // shell's open never blocks and the reader sees EOF only after task_input closes it.
    const fifo = args.stdin ? this.path(id, "stdin") : undefined;
    let stdinFd: number | undefined;
    try {
      if (fifo) {
        const made = spawnSync("mkfifo", ["-m", "600", fifo]);
        if (made.status !== 0) throw new Error(`Cannot create stdin pipe: ${made.stderr?.toString().trim() || made.error?.message || `mkfifo exited with ${made.status}`}`);
        stdinFd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      }
      this.save(record); started(id);
    } catch (error) {
      closeSync(fd);
      if (stdinFd !== undefined) closeSync(stdinFd);
      if (fifo) rmSync(fifo, { force: true });
      throw error;
    }
    const task: Running = { record, controller: new AbortController(), done: Promise.resolve(), background: args.run_in_background === true, stdinFd };
    this.running.set(id, task);
    let storageError: Error | undefined;
    // The shell leads its own process group. Recording its PID shows whether
    // processes it started with `&` or nohup outlive it. The record shares the
    // first line, so Bash error line numbers stay unchanged.
    const groupFile = this.trackGroups ? this.path(id, "pgid") : undefined;
    const tool = createBashTool(cwd, { commandPrefix: args.pipefail ? "set -o pipefail" : undefined, operations: { exec: async (command, directory, options) => {
      // The shell removes the FIFO's name once it has opened it, which tells input() the reader is attached.
      const stdin = fifo ? `exec 0<${quote(fifo)}; rm -f ${quote(fifo)}; ` : "";
      const exit = await this.operations.exec(`${groupFile ? `printf '%s' "$$" > ${quote(groupFile)} 2>/dev/null; ` : ""}${stdin}${command}`, directory, { ...options, onData: data => {
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
      if (groupFile) this.watchGroup(id, groupFile);
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
        if (task.stdinFd !== undefined) { closeSync(task.stdinFd); task.stdinFd = undefined; }
        if (fifo) rmSync(fifo, { force: true });
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
        const output = await this.foregroundResult(task);
        const notice = this.groupNotice(id).trim();
        return notice ? { ...output, content: [...output.content, { type: "text" as const, text: `\n\n[${notice}]` }] } : output;
      }
      signal?.throwIfAborted();
      task.background = true;
    }
    return result({ task_id: id, status: args.run_in_background ? "started" : "auto_promoted", message: "The command is running in the background. Do not rerun it. Use task_output to read output; unobserved completion will notify the owning conversation." });
  }
  /** Writes `text` to a running task's stdin; `eof` then closes it. */
  async input(id: string, text = "", eof = false) {
    const task = this.running.get(id);
    if (!task || terminal(task.record.status)) throw new Error(`Task ${id} is not running`);
    if (!task.record.stdin) throw new Error("This task has no stdin pipe. Start the command with bash stdin=true to send it input.");
    if (task.stdinFd === undefined) throw new Error("This task's stdin is already closed");
    const data = Buffer.from(text);
    let written = 0;
    try {
      while (written < data.length) written += writeSync(task.stdinFd, data, written, data.length - written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      throw new Error(`The pipe is full because the process is not reading stdin; wrote ${written} of ${data.length} bytes.`);
    }
    if (eof) {
      // Closing before the shell opens the FIFO would leave its open() waiting for a writer forever.
      const fifo = this.path(id, "stdin");
      for (let waited = 0; existsSync(fifo) && waited < 5_000 && !terminal(task.record.status); waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
      if (task.stdinFd !== undefined) { closeSync(task.stdinFd); task.stdinFd = undefined; }
    }
    return { bytes_written: written, stdin_closed: task.stdinFd === undefined };
  }
  /** Waits until the task ends, `ms` elapses, or `signal` aborts. */
  async settle(id: string, ms: number, signal?: AbortSignal) {
    const task = this.running.get(id);
    if (!task || ms <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined, abort = () => {};
    try {
      await Promise.race([task.done, new Promise<void>(resolve => {
        timer = setTimeout(resolve, ms); abort = resolve;
        signal?.addEventListener("abort", abort, { once: true });
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
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
      this.readTo.set(cursor, Math.max(this.readTo.get(cursor) ?? 0, next));
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
  // Completions delivered to the conversation whose output may still be unread.
  // A task_output batched with sleep runs at once, so it can read a task just
  // before it finishes; the next sleep then reminds once instead of waiting on
  // a task that already ended.
  const reported = new Set<string>();
  // Steering releases only the current waits. It must not cancel their processes
  // or make later waits yield to a message Pi has already delivered.
  type Wake = "steering" | "swarm" | "task" | "process";
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
  // A sleep also waits on processes a command left running, such as `nohup job &`.
  const detachGroups = tasks.onGroupExit(id => {
    if (sleepers.size && current && ids(current).includes(id)) for (const wake of [...sleepers]) wake("process");
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
    for (const id of pending) { notifications.delete(id); tasks.acknowledge(id, "notified"); reported.add(id); }
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
    shuttingDown = true; current = undefined; clearTimeout(notificationTimer); detach(); detachGroups(); detachBackground(); detachSwarm();
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
    description: "Execute Bash in the current working directory. A command still running after 5 seconds returns a background task ID for the same process, and processes a command leaves running with & or nohup are tracked until they exit; user steering or a swarm message returns it sooner. Do not rerun a returned task; call sleep to wait for it, then task_output to read it. run_in_background returns the task ID immediately. Every command has a 1800-second default deadline; set timeout for a longer one. Output is bounded to 2000 lines or 50KB; full output is saved. pipefail=true enables Bash pipeline failure detection without enabling errexit. Stopping or timing out a local process does not guarantee that remote work stops. Before a long job, estimate its run time and try a small case first, such as one epoch or a data subset. Run servers and interactive programs in the background. stdin is empty unless stdin=true.",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ description: "Deadline in seconds, default 1800. Non-positive values use 1800; values are capped at 2147483.647. Background promotion keeps the deadline. Expiry kills the process tree." })), run_in_background: Type.Optional(Type.Boolean({ description: "Return the task ID immediately instead of waiting up to 5 seconds." })), pipefail: Type.Optional(Type.Boolean({ description: "Enable set -o pipefail: a pipeline returns the rightmost nonzero exit status, or zero if all commands succeed. Off by default; does not enable set -e or report each command's status." })), stdin: Type.Optional(Type.Boolean({ description: "Keep stdin open as a pipe so task_input can write to it, for REPLs, debuggers, engines, and VM consoles. Off by default." })) }),
    async execute(_id, args, signal, _update, ctx) {
      check(ctx); current = ctx;
      try {
        return await tasks.run(ctx.cwd, args, signal, id => pi.appendEntry(taskKey, id), () => {}, steering.signal);
      } finally { publishBackground(); }
    },
  });
  pi.registerTool({ name: "sleep", label: "sleep", renderCall: toolCall("sleep"), renderResult,
    description: `Wait without polling. Returns early when the user steers, a swarm message, alert or check-in arrives, a background task on this branch finishes, or the last process a Bash command left running (for example with nohup or &) exits; otherwise returns after seconds (1-${maxSleepSeconds}) with a progress snapshot of running tasks. The result names the wake reason and includes completion notices, which replace a separate completion turn. Read finished output with task_output before claiming success; do not call task_output in the same batch as sleep, because batched calls run at once and the read happens before the task finishes. A sleep after a reported completion whose output is still unread returns at once with woke "unread". Sleeping never stops or extends a task. Silence in a snapshot does not prove that a process is stuck, but read task_output between sleeps: if a job is not progressing at the rate you estimated, stop it with task_stop and change approach instead of waiting for its deadline.`,
    parameters: Type.Object({ seconds: Type.Integer({ minimum: 1, maximum: maxSleepSeconds, description: "Longest wait in seconds. The call returns sooner on a wake event." }) }),
    async execute(_id, args, signal, _update, ctx) {
      check(ctx); signal?.throwIfAborted(); current = ctx;
      if (!Number.isSafeInteger(args.seconds) || args.seconds < 1 || args.seconds > maxSleepSeconds) throw new Error(`seconds must be an integer between 1 and ${maxSleepSeconds}`);
      const started = Date.now();
      const session = ctx.sessionManager.getSessionId();
      const ready = () => { const owned = new Set(ids(ctx)); return [...notifications].filter(id => owned.has(id)); };
      // Remind once about reported tasks whose output is still unread, so a
      // read that raced the completion cannot leave this sleep waiting on nothing.
      const owned = new Set(ids(ctx));
      const unread = [...reported].filter(id => owned.has(id) && tasks.unreadBytes(id, session) > 0);
      for (const id of [...reported]) if (owned.has(id)) reported.delete(id);
      const exited = () => tasks.detachedGroups(ids(ctx)).filter(group => group.exited_at);
      let reason: Wake | "timeout" | "unread" = "task";
      if (unread.length && !ready().length) reason = "unread";
      else if (!ready().length && exited().length) reason = "process";
      else if (!ready().length) {
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
      for (const id of finished) { notifications.delete(id); tasks.acknowledge(id, "notified"); reported.add(id); }
      const completed = finished.map(id => {
        const task = tasks.query(id);
        return { task_id: id, status: task.status, exit_code: task.exit_code ?? null, unread_bytes: tasks.unreadBytes(id, session), notice: tasks.completionNotice(id) };
      });
      const reminders = reason !== "unread" ? undefined : unread.map(id => {
        const task = tasks.query(id);
        return { task_id: id, status: task.status, exit_code: task.exit_code ?? null, unread_bytes: tasks.unreadBytes(id, session) };
      });
      const running = reason !== "timeout" ? undefined : await Promise.all(tasks.background(ids(ctx)).map(async ({ taskId }) => {
        const { task_id, command, status, elapsed_seconds, output_bytes, output_silence_seconds, deadline_remaining_seconds, recent_output } = await tasks.progress(taskId);
        return { task_id, command: command.slice(0, 200), status, elapsed_seconds, output_bytes, output_silence_seconds, deadline_remaining_seconds, recent_output };
      }));
      const groups = tasks.detachedGroups(ids(ctx));
      const ended = groups.filter(group => group.exited_at);
      for (const group of ended) tasks.forgetGroup(group.task_id);
      const detached = reason !== "timeout" ? undefined : groups.filter(group => !group.exited_at).map(({ task_id, command, pgid }) => ({ task_id, command, pgid }));
      const message = reason === "steering" ? "New user input is waiting. Read and handle it."
        : reason === "swarm" ? "A swarm message is waiting. Read and handle it."
        : reason === "task" ? "Use task_output to inspect the results before claiming success."
        : reason === "unread" ? "These tasks already finished, but their output was not read to the end. Read it with task_output; nothing is left to wait for."
        : reason === "process" ? "Every process these commands left running has exited. Check their logs or results; they may have failed."
        : running?.length || detached?.length ? "Sleep finished. Report progress from the snapshot, or sleep again." : "Sleep finished. No background tasks are running on this branch.";
      return result({ woke: reason, slept_seconds: Math.round((Date.now() - started) / 100) / 10, completed, ...(ended.length ? { processes_exited: ended } : {}), ...(reminders ? { unread: reminders } : {}), ...(running ? { running } : {}), ...(detached?.length ? { detached } : {}), message });
    },
  });
  const definitions = [
    { name: "task_query", description: "Query background tasks on this session branch. Omit task_id to list tasks; pass task_id to get one. status filters the list.", parameters: Type.Object({ task_id: Type.Optional(Type.String()), status: Type.Optional(Type.Union(taskStatuses.map(status => Type.Literal(status)))) }),
      run: async (args: { task_id?: string; status?: Status }, _signal: AbortSignal | undefined, ctx: ExtensionContext) => args.task_id ? tasks.query(args.task_id) : ids(ctx).map(id => tasks.query(id)).filter(task => !args.status || task.status === args.status) },
    { name: "task_output", description: "Read output from a background task without waiting. Call sleep to wait for output or completion instead of polling. Returning terminal status acknowledges completion without discarding unread output. Omit offset consistently for an automatic cursor; explicit offsets do not advance it.", parameters: Type.Object({ task_id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset, not a page number. Use next_offset for incremental reads; 0 replays existing output." })) }),
      run: (args: { task_id: string; offset?: number }, signal: AbortSignal | undefined, ctx: ExtensionContext) => tasks.output(args.task_id, args.offset, signal, ctx.sessionManager.getSessionId()) },
    { name: "task_input", description: "Write text to the stdin of a running task started with bash stdin=true, such as a REPL, debugger, chess engine, or VM console. End the text with a newline to submit a line. eof=true closes stdin after the write. Then waits up to wait_seconds or until the task ends, and returns new output from the automatic task_output cursor. stdin is a pipe, not a terminal; a program that buffers output off a terminal may need an unbuffered flag such as python -u, or a pseudo-terminal wrapper such as script.", parameters: Type.Object({ task_id: Type.String(), text: Type.Optional(Type.String({ description: "Text to write. Escape sequences are not interpreted; send control characters literally." })), eof: Type.Optional(Type.Boolean({ description: "Close stdin after writing." })), wait_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: maxInputWaitSeconds, description: `Seconds to wait for output before returning, 0-${maxInputWaitSeconds}, default 2.` })) }),
      run: async (args: { task_id: string; text?: string; eof?: boolean; wait_seconds?: number }, signal: AbortSignal | undefined, ctx: ExtensionContext) => {
        const wait = args.wait_seconds ?? 2;
        if (!Number.isFinite(wait) || wait < 0 || wait > maxInputWaitSeconds) throw new Error(`wait_seconds must be between 0 and ${maxInputWaitSeconds}`);
        const written = await tasks.input(args.task_id, args.text, args.eof);
        await tasks.settle(args.task_id, wait * 1000, signal);
        return { ...written, ...await tasks.output(args.task_id, undefined, signal, ctx.sessionManager.getSessionId()) };
      } },
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
