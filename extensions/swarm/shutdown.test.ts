import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { shellQuote } from "../../lib/common.ts";
import { Workers } from "./worker.ts";

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test("stopping a real Pi worker kills its detached Bash task and descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-shutdown-"));
  const workers = new Workers(`pi-worker-shutdown-${randomUUID()}`);
  const node = randomUUID();
  const executable = join(root, "isolated-pi");
  const extension = join(root, "fixture.ts");
  const childScript = join(root, "child.cjs");
  const cli = resolve(import.meta.dir, "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const tasks = resolve(import.meta.dir, "../tasks/tasks.ts");
  let pids: { worker: number; task: number; child: number } | undefined;
  try {
    await writeFile(childScript, `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync("children.json", JSON.stringify({ task: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`);
    await writeFile(extension, `import { writeFileSync } from "node:fs";
import { Tasks, registerTaskTools, taskKey } from ${JSON.stringify(tasks)};
export default function (pi) {
  const tasks = new Tasks();
  registerTaskTools(pi, tasks);
  pi.on("session_start", async (_event, ctx) => {
    writeFileSync("worker.pid", String(process.pid));
    await tasks.run(ctx.cwd, {
      command: ${JSON.stringify(`${shellQuote(process.execPath)} ${shellQuote(childScript)}`)},
      run_in_background: true,
    }, undefined, id => pi.appendEntry(taskKey, id), () => {});
  });
}
`);
    // Do not inherit credentials, the live agent directory, or a model prompt.
    await writeFile(executable, `#!/bin/sh
exec env -i PATH=${shellQuote(process.env.PATH!)} HOME=${shellQuote(root)} TERM=xterm-256color PI_CODING_AGENT_DIR=${shellQuote(join(root, "agent"))} ${shellQuote(process.execPath)} ${shellQuote(cli)} --no-extensions --no-skills --no-prompt-templates --no-themes --extension ${shellQuote(extension)}
`, { mode: 0o700 });
    await workers.start({ run: randomUUID(), node, cwd: root, directory: join(root, "state"), executable });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        pids = { worker: Number(await readFile(join(root, "worker.pid"), "utf8")), ...JSON.parse(await readFile(join(root, "children.json"), "utf8")) };
        break;
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        await delay(50);
      }
    }
    if (!pids) throw new Error(`Worker did not start its task: ${await workers.observe(node, 50)}`);
    expect(Object.values(pids).every(alive)).toBe(true);
    await workers.stop(node);
    const stopped = Date.now() + 5000;
    while (Object.values(pids).some(alive) && Date.now() < stopped) await delay(25);
    expect(await workers.alive(node)).toBe(false);
    expect(Object.values(pids).filter(alive)).toEqual([]);
  } finally {
    await workers.tmux("kill-server").catch(() => {});
    if (pids) for (const pid of Object.values(pids)) if (alive(pid)) process.kill(pid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
