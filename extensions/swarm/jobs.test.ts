import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Jobs } from "./jobs.ts";
test("real tmux PTY jobs: exit, persistence, input, ownership, kill and abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-")); const jobs = new Jobs(root); const started = [];
  try {
    const short = await jobs.start("a", root, "printf 'héllo'; exit 7"); started.push(short);
    await jobs.wait(short, 3);
    const output = await jobs.output(short);
    expect(output.stdout).toContain("héllo"); expect(output.exit_code).toBe(7);
    expect((await jobs.output(short, 3)).truncated).toBe(true);
    const live = await jobs.start("a", root, "read answer; printf 'answer:%s' \"$answer\"; sleep 5"); started.push(live);
    await jobs.wait(live, 0.1); expect((await jobs.status(live)).status).toBe("running");
    await expect(jobs.load(live.id, "b")).rejects.toThrow("another session");
    expect((await new Jobs(root).load(live.id, "b", true)).id).toBe(live.id);
    await jobs.input(live, "test\n", false);
    await jobs.wait(live, 0.15); expect((await jobs.output(live)).stdout).toContain("answer:test");
    const abort = new AbortController(); abort.abort();
    await expect(jobs.wait(live, 1, abort.signal)).rejects.toThrow();
    await jobs.kill(live); expect((await jobs.status(live)).exit_code).toBe(137);
    expect(await jobs.list("b")).toHaveLength(0); expect(await jobs.list("b", true)).toHaveLength(2);
  } finally {
    for (const job of started) if ((await jobs.status(job)).status === "running") await jobs.kill(job);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
