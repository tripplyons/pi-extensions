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

test("users can edit and resume blocked goals with a fresh blocked audit", async () => {
  const h = harness(); install(h.pi);
  await h.call("create_goal", { objective: "Original" });
  for (let i = 0; i < 3; i++) await h.emit("agent_end");
  await h.call("update_goal", { status: "blocked" });
  await h.command("goal:edit", "Revised objective");
  expect((await h.call("get_goal", {})).details.objective).toBe("Revised objective");
  expect((await h.call("get_goal", {})).details.status).toBe("blocked");
  await h.command("goal:resume");
  expect((await h.call("get_goal", {})).details.continuations).toBe(0);
  await expect(h.call("update_goal", { status: "blocked" })).rejects.toThrow("three");
  await h.command("goal:pause");
  expect((await h.call("get_goal", {})).details.status).toBe("paused");
  await h.command("goal:clear");
  expect((await h.call("get_goal", {})).details).toBeNull();
});

test("swarm attachment pauses goals and prevents competing continuation loops", async () => {
  const h = harness(); install(h.pi);
  await h.call("create_goal", { objective: "Verify" });
  h.pi.appendEntry("rework:swarm", { run: "run", node: "root" });
  h.pi.events.emit("rework:swarm-attached", h.ctx);
  expect((await h.call("get_goal", {})).details.status).toBe("paused");
  await h.emit("agent_end"); expect(h.sent).toHaveLength(0);
  await expect(h.command("goal:resume")).rejects.toThrow("attached swarm");
  await expect(h.call("create_goal", { objective: "Other" })).rejects.toThrow("attached swarm");
  h.pi.appendEntry("rework:swarm", null);
  await h.emit("agent_end"); expect(h.sent).toHaveLength(0);
  await h.command("goal:resume");
  expect((await h.call("get_goal", {})).details.status).toBe("active");
});
