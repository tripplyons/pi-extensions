import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import install from "./index.ts";
import { harness } from "../../lib/harness.ts";
test("swarm activation is user-only, session-bound, and exposes all tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-extension-"));
  const previous = process.env.PI_REWORK_STATE_DIR; process.env.PI_REWORK_STATE_DIR = root;
  const h = harness();
  try {
    install(h.pi); expect(h.tools.size).toBe(12);
    await expect(h.call("swarm_task", {})).rejects.toThrow("inactive");
    await h.command("swarm:start", "Build the feature");
    expect((await h.call("swarm_task", {})).details.objective).toBe("Build the feature");
    await expect(h.command("swarm:start", "Again")).rejects.toThrow("already");
    h.ctx.sessionManager.getSessionId = () => "other";
    await expect(h.call("swarm_tree", {})).rejects.toThrow("another root session");
    h.ctx.sessionManager.getSessionId = () => "test-session";
    await h.call("swarm_clear", {});
    await expect(h.call("swarm_task", {})).rejects.toThrow("inactive");
  } finally {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_REWORK_STATE_DIR; else process.env.PI_REWORK_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
