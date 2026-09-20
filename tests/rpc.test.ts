import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import manifest from "../package.json";

test("real Pi RPC loads without local dependencies and activates MiniMax and swarm without model requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-rpc-rework-"));
  const project = resolve(import.meta.dir, "..");
  // Test the shipped package, not imports accidentally supplied by test-only
  // node_modules links. Pi must supply its documented extension imports.
  const installed = join(home, "package");
  for (const directory of ["extensions", "lib"]) await cp(join(project, directory), join(installed, directory), { recursive: true });
  const args = [join(project, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"];
  for (const path of manifest.pi.extensions) args.push("--extension", join(installed, path));
  // Allowlist environment: never inherit provider credentials or the live agent directory.
  const child = spawn("node", args, { cwd: home, env: {
    PATH: process.env.PATH, HOME: home, TERM: "dumb", PI_CODING_AGENT_DIR: join(home, "agent"),
    PI_REWORK_STATE_DIR: join(home, "state"), XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
  }, stdio: ["pipe", "pipe", "pipe"] });
  const events: any[] = [];
  let errors = "", serial = 0;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  child.stderr.on("data", chunk => { errors += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    events.push(event);
    if (event.type === "response" && pending.has(event.id)) {
      const waiter = pending.get(event.id)!;
      pending.delete(event.id);
      if (event.success) waiter.resolve(event.data); else waiter.reject(new Error(event.error));
    }
  });
  const exited = new Promise<void>(resolve => child.once("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Pi exited: ${errors}`));
    pending.clear(); resolve();
  }));
  function request(type: string, extra = {}) {
    return new Promise<any>((resolve, reject) => {
      const id = String(++serial);
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${type} timed out: ${errors}`)); }, 10000);
      pending.set(id, {
        resolve(value) { clearTimeout(timeout); resolve(value); },
        reject(error) { clearTimeout(timeout); reject(error); },
      });
      child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    });
  }
  try {
    const { commands } = await request("get_commands");
    for (const name of ["swarm:start", "goal", "codex-usage", "api-cost", "btw", "btw:tools", "nvim", "autoresearch", "threshold"])
      expect(commands.some((command: any) => command.name === name)).toBe(true);
    for (const name of ["minimax", "pruner", "prune", "jev", "codex-compact"])
      expect(commands.some((command: any) => command.name === name)).toBe(false);
    await request("prompt", { message: "/threshold" });
    expect(events.some(event => event.type === "extension_ui_request" && event.method === "notify" && event.message === "Compaction threshold 60000 tokens")).toBe(true);
    await request("prompt", { message: "/swarm:start Verify isolated RPC activation" });
    const runs = await readdir(join(home, "state", "swarm"));
    expect(runs).toHaveLength(1);
    const run = JSON.parse(await readFile(join(home, "state", "swarm", runs[0], "run.json"), "utf8"));
    expect(run.objective).toBe("Verify isolated RPC activation");
    expect((await request("get_state")).isStreaming).toBe(false);
    expect(events.some(event => event.type === "agent_start")).toBe(false);
    expect(events.filter(event => event.type === "extension_error")).toEqual([]);
  } finally {
    lines.close(); child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited; clearTimeout(timeout);
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
