import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { shellQuote } from "../../lib/common.ts";
const exec = promisify(execFile);
export type Launch = { run: string; node: string; cwd: string; directory: string; extensions: string[]; executable?: string; model?: string; thinking?: string };
export class Workers {
  constructor(readonly socket?: string) {}
  async tmux(...args: string[]) {
    return (await exec("tmux", [...(this.socket ? ["-L", this.socket] : []), ...args], { maxBuffer: 1024 * 1024 })).stdout;
  }
  name(node: string) {
    if (!/^[0-9a-f-]{36}$/.test(node)) throw new Error("Invalid worker node ID");
    return `pi-swarm-${node}`;
  }
  async start(options: Launch) {
    const name = this.name(options.node);
    if (![options.cwd, options.directory, ...options.extensions].every(isAbsolute)) throw new Error("Worker paths must be absolute");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const session = join(options.directory, "session.jsonl");
    const args = [options.executable ?? "pi", "--session", session, "--no-extensions"];
    for (const path of options.extensions) args.push("--extension", path);
    if (options.model) args.push("--model", options.model);
    if (options.thinking) args.push("--thinking", options.thinking);
    args.push("Read your durable assignment with swarm_task, then carry it out. You are a swarm worker. Ask your parent instead of prompting the user. Submit results with swarm_complete; never merge or push branches.");
    const script = join(options.directory, "worker.zsh");
    await writeFile(script, `export PI_SWARM_RUN=${shellQuote(options.run)}\nexport PI_SWARM_NODE=${shellQuote(options.node)}\nexec ${args.map(shellQuote).join(" ")}\n`, { mode: 0o600 });
    // Each worker owns a separate attachable session. Never split or replace the user's pane.
    await this.tmux("new-session", "-d", "-s", name, "-c", options.cwd, `zsh ${shellQuote(script)}`);
    return { pane: name, session };
  }
  async alive(node: string) {
    try { await this.tmux("has-session", "-t", `=${this.name(node)}`); return true; }
    catch { return false; }
  }
  async observe(node: string, lines: number) {
    if (!Number.isInteger(lines) || lines < 1 || lines > 2000) throw new Error("lines must be 1–2000");
    const output = await this.tmux("capture-pane", "-p", "-t", `=${this.name(node)}:`, "-S", `-${lines - 1}`);
    return output.trimEnd().split("\n").slice(-lines).join("\n");
  }
  async stop(node: string) {
    if (await this.alive(node)) await this.tmux("kill-session", "-t", `=${this.name(node)}`);
  }
}
