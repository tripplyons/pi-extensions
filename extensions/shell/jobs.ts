import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, writeFile, rm, open } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { shellQuote } from "../../lib/common.ts";
const exec = promisify(execFile);
export type Job = { id: string; session: string; cwd: string; command: string; created: string; pane: string };
export class Jobs {
  constructor(readonly root: string) {}
  dir(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid job ID");
    return join(this.root, id);
  }
  async tmux(...args: string[]) { return (await exec("tmux", ["-L", "pi-rework", ...args], { maxBuffer: 1024 * 1024 })).stdout; }
  async start(session: string, cwd: string, command: string) {
    if (!isAbsolute(cwd)) throw new Error("Job cwd must be absolute");
    const id = randomUUID(); const dir = this.dir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const script = join(dir, "run.zsh");
    const job: Job = { id, session, cwd, command, created: new Date().toISOString(), pane: `job-${id}` };
    await writeFile(join(dir, "command.zsh"), command, { mode: 0o600 });
    // The gate lets pipe-pane attach before even a fast command can produce output.
    await writeFile(script, `while [[ ! -f ${shellQuote(join(dir, "ready"))} ]]; do sleep 0.02; done\nzsh ${shellQuote(join(dir, "command.zsh"))}\ncode=$?\nprintf '%s' "$code" > ${shellQuote(join(dir, "exit.tmp"))}\nmv ${shellQuote(join(dir, "exit.tmp"))} ${shellQuote(join(dir, "exit"))}\n`, { mode: 0o600 });
    await writeFile(join(dir, "job.json"), JSON.stringify(job), { mode: 0o600 });
    try {
      await this.tmux("new-session", "-d", "-s", job.pane, "-c", cwd, `zsh ${shellQuote(script)}`);
      await this.tmux("pipe-pane", "-t", job.pane, `cat >> ${shellQuote(join(dir, "output"))}`);
      await writeFile(join(dir, "ready"), "", { mode: 0o600 });
    } catch (error) {
      await this.tmux("kill-session", "-t", job.pane).catch(() => {});
      await rm(dir, { recursive: true, force: true }); throw error;
    }
    return job;
  }
  async load(id: string, session: string, all = false): Promise<Job> {
    const job = JSON.parse(await readFile(join(this.dir(id), "job.json"), "utf8")) as Job;
    if (job.id !== id || job.pane !== `job-${id}`) throw new Error("Invalid job record");
    if (!all && job.session !== session) throw new Error("Job belongs to another session; explicitly use scope=all");
    return job;
  }
  async status(job: Job) {
    try {
      const code = Number(await readFile(join(this.dir(job.id), "exit"), "utf8"));
      return { status: "exited" as const, exit_code: code };
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    try { await this.tmux("has-session", "-t", job.pane); return { status: "running" as const }; }
    catch { return { status: "lost" as const }; }
  }
  async list(session: string, all = false) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const jobs = [];
    for (const id of await readdir(this.root)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const job = await this.load(id, session, true);
      if (all || job.session === session) jobs.push({ ...job, ...await this.status(job) });
    }
    return jobs;
  }
  async output(job: Job, maxBytes = 64 * 1024, lines?: number) {
    let stdout = ""; let truncated = false;
    try {
      const file = await open(join(this.dir(job.id), "output"), "r");
      try {
        const { size } = await file.stat(); const offset = Math.max(0, size - maxBytes);
        const buffer = Buffer.alloc(Math.min(size, maxBytes));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        let start = 0;
        if (offset) while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
        stdout = buffer.subarray(start, bytesRead).toString("utf8"); truncated = offset > 0;
      } finally { await file.close(); }
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    if (lines) { const parts = stdout.split("\n"); truncated ||= parts.length > lines; stdout = parts.slice(-lines).join("\n"); }
    return { id: job.id, ...await this.status(job), stdout, truncated, log: join(this.dir(job.id), "output") };
  }
  async input(job: Job, input: string, end: boolean) {
    if ((await this.status(job)).status !== "running") throw new Error("Job is not running");
    // tmux's literal send-keys prevents text from being interpreted as key names.
    if (input) await this.tmux("send-keys", "-t", job.pane, "-l", "--", input);
    if (end) await this.tmux("send-keys", "-t", job.pane, "C-d");
  }
  async kill(job: Job) {
    if ((await this.status(job)).status !== "running") return;
    await this.tmux("kill-session", "-t", job.pane);
    await writeFile(join(this.dir(job.id), "exit"), "137", { mode: 0o600 });
  }
  async wait(job: Job, seconds: number, signal?: AbortSignal) {
    const end = Date.now() + seconds * 1000;
    while ((await this.status(job)).status === "running" && Date.now() < end) {
      signal?.throwIfAborted(); await delay(Math.min(50, Math.max(1, end - Date.now())), undefined, { signal });
    }
    signal?.throwIfAborted();
    // Give pipe-pane's final bytes a chance to flush after the exit marker.
    if ((await this.status(job)).status !== "running") await delay(30);
  }
}
