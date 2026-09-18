import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";
test("goal continuations, completion and user-only pause/resume", async () => {
  const h = harness(); install(h.pi);
  await h.call("create_goal", { objective: "Verify everything" });
  await expect(h.call("create_goal", { objective: "Other" })).rejects.toThrow("unfinished");
  await expect(h.call("update_goal", { status: "blocked" })).rejects.toThrow("three");
  await h.emit("agent_end"); expect(h.sent).toHaveLength(1);
  await h.command("goal", "pause"); await h.emit("agent_end"); expect(h.sent).toHaveLength(1);
  await h.command("goal", "resume");
  await h.call("update_goal", { status: "complete" });
  const count = h.sent.length; await h.emit("agent_end"); expect(h.sent).toHaveLength(count);
});
test("resume loads a paused goal and active-branch state", async () => {
  const h = harness(); install(h.pi);
  await h.call("create_goal", { objective: "Original" });
  await h.emit("session_switch");
  expect((await h.call("get_goal", {})).details.status).toBe("paused");
  h.entries.length = 0; await h.emit("session_fork");
  expect((await h.call("get_goal", {})).details).toBeNull();
});
