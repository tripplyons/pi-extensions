import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Workers } from "./worker.ts";
test("worker PTY launch, environment, literal arguments, capture and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-"));
  const workers = new Workers(`pi-worker-test-${randomUUID()}`);
  const node = randomUUID(), run = randomUUID();
  const executable = join(root, "fake worker");
  try {
    await writeFile(executable, '#!/bin/zsh\nprintf "%s\\n" "$PI_SWARM_NODE" "$PI_SWARM_RUN" "$@" > args\nprintf "WORKER READY\\n"\nwhile true; do sleep 1; done\n', { mode: 0o700 });
    const options = { run, node, cwd: root, directory: join(root, "state"), extensions: [join(root, "extension with spaces.ts")], executable, model: "provider/model", thinking: "high" };
    const launched = await workers.start(options);
    let output = "";
    for (let i = 0; i < 50; i++) {
      output = await workers.observe(node, 20);
      if (output.includes("WORKER READY")) break;
      await delay(20);
    }
    expect(output).toContain("WORKER READY");
    const args = (await readFile(join(root, "args"), "utf8")).split("\n");
    expect(args.slice(0, 2)).toEqual([node, run]);
    expect(args).toContain(options.extensions[0]);
    expect(args).toContain(launched.session);
    expect(await workers.alive(node)).toBe(true);
    await expect(workers.start(options)).rejects.toThrow();
    await workers.stop(node); expect(await workers.alive(node)).toBe(false);
    expect((await workers.start(options)).session).toBe(launched.session);
    await workers.stop(node);
  } finally {
    await workers.tmux("kill-server").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
