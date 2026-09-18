import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";
test("shell tools retain jobs, wake on completion, and clear finished records", async () => {
 const root = await mkdtemp(join(tmpdir(), "pi-shell-")); const previous = process.env.PI_REWORK_STATE_DIR;
 process.env.PI_REWORK_STATE_DIR = root;
 const h = harness(); install(h.pi);
 try {
   const launched = await h.call("shell", { command: "sleep 0.5; echo done", cwd: root, timeout: 0.1, max_output_bytes: 1024 });
   expect(launched.details.background).toBe(true);
   expect((await h.call("sleep", { seconds: 3 })).details.reason).toBe("job_exit");
   const output = await h.call("bg_process", { action: "output", id: launched.details.id });
   expect(output.details.stdout).toContain("done");
   expect((await h.call("bg_process", { action: "clear" })).details.cleared).toEqual([launched.details.id]);
   h.ctx.hasPendingMessages = () => true;
   expect((await h.call("sleep", { seconds: 3 })).details.reason).toBe("activity");
 } finally {
   for (const job of (await h.call("bg_process", { action: "list" })).details.jobs) if (job.status === "running") await h.call("bg_process", { action: "kill", id: job.id });
   if (previous === undefined) delete process.env.PI_REWORK_STATE_DIR; else process.env.PI_REWORK_STATE_DIR = previous;
   await rm(root, { recursive: true, force: true });
 }
}, 10000);
