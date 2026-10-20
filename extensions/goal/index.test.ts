import { expect, test } from "bun:test";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";
test("goal continuations, completion and user-only pause/resume", async () => {
  const h = harness(); install(h.pi);
  const deliveries: unknown[] = [];
  h.pi.sendUserMessage = (message: string, options: unknown) => { h.sent.push(message); deliveries.push(options); };
  await h.command("goal", "new Verify everything");
  expect(deliveries).toEqual([{ deliverAs: "steer" }]);
  h.sent.length = 0; deliveries.length = 0;
  await expect(h.call("create_goal", { objective: "Other" })).rejects.toThrow("unfinished");
  await expect(h.call("update_goal", { status: "blocked" })).rejects.toThrow("three");
  await h.emit("agent_end"); expect(h.sent).toHaveLength(1);
  expect(deliveries).toEqual([{ deliverAs: "steer" }]);
  await h.command("goal", "pause"); await h.emit("agent_end"); expect(h.sent).toHaveLength(1);
  await h.command("goal", "resume");
  expect(deliveries.at(-1)).toEqual({ deliverAs: "steer" });
  await h.call("update_goal", { status: "complete" });
  const count = h.sent.length; await h.emit("agent_end"); expect(h.sent).toHaveLength(count);
});
test("resume loads a paused goal and active-branch state", async () => {
  const h = harness(); install(h.pi);
  await h.call("create_goal", { objective: "Original" });
  await h.emit("session_start", { reason: "resume" });
  expect((await h.call("get_goal", {})).details.status).toBe("paused");
  h.entries.length = 0; await h.emit("session_start", { reason: "fork" });
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
  h.pi.appendEntry("pi:swarm", { run: "run", node: "root" });
  h.pi.events.emit("pi:swarm-attached", h.ctx);
  expect((await h.call("get_goal", {})).details.status).toBe("paused");
  await h.emit("agent_end"); expect(h.sent).toHaveLength(0);
  await expect(h.command("goal:resume")).rejects.toThrow("attached swarm");
  await expect(h.call("create_goal", { objective: "Other" })).rejects.toThrow("attached swarm");
  h.pi.appendEntry("pi:swarm", null);
  await h.emit("agent_end"); expect(h.sent).toHaveLength(0);
  await h.command("goal:resume");
  expect((await h.call("get_goal", {})).details.status).toBe("active");
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (stopReason: string) => ({ message: { role: "assistant", stopReason, usage } });
const status = async (h: ReturnType<typeof harness>) => (await h.call("get_goal", {})).details.status;

test("a retried model error keeps the goal running", async () => {
  const h = harness(); install(h.pi);
  await h.call("create_goal", { objective: "Verify" });
  await h.emit("message_end", assistant("error"));
  await h.emit("agent_end"); expect(h.sent).toHaveLength(0);
  expect(await status(h)).toBe("active");
  await h.emit("message_end", assistant("stop"));
  await h.emit("agent_end"); expect(h.sent).toHaveLength(1);
  await h.emit("agent_settled", { aborted: false });
  expect(await status(h)).toBe("active");
});

test("an error left after retries pauses the goal", async () => {
  const h = harness(); install(h.pi);
  await h.call("create_goal", { objective: "Verify" });
  await h.emit("message_end", assistant("error"));
  await h.emit("agent_end");
  await h.emit("agent_settled", { aborted: false });
  expect(await status(h)).toBe("paused");
  expect(h.sent).toHaveLength(0);
});

test("Escape pauses the goal at once", async () => {
  const h = harness(); install(h.pi);
  await h.call("create_goal", { objective: "Verify" });
  await h.emit("message_end", assistant("aborted"));
  expect(await status(h)).toBe("paused");
});

test("online compaction's planned stop leaves the goal to its hidden turn", async () => {
  const h = harness(); install(h.pi);
  await h.call("create_goal", { objective: "Verify" });
  h.pi.events.emit("pi:online-compaction", { phase: "aborting", ctx: h.ctx });
  await h.emit("message_end", assistant("error"));
  await h.emit("agent_end"); expect(h.sent).toHaveLength(0);
  await h.emit("agent_settled", { aborted: true });
  expect(await status(h)).toBe("active");
  h.pi.events.emit("pi:online-compaction", { phase: "continuing", ctx: h.ctx });
  await h.emit("message_end", assistant("stop"));
  await h.emit("agent_end"); expect(h.sent).toHaveLength(1);
});

test("Escape during online compaction pauses the goal", async () => {
  const h = harness(); install(h.pi);
  await h.call("create_goal", { objective: "Verify" });
  h.pi.events.emit("pi:online-compaction", { phase: "aborting", ctx: h.ctx });
  await h.emit("message_end", assistant("aborted"));
  expect(await status(h)).toBe("active");
  h.pi.events.emit("pi:online-compaction", { phase: "stopped", ctx: h.ctx });
  expect(await status(h)).toBe("paused");
});
