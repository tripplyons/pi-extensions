import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import install from "./index.ts";
import { SwarmStore } from "./state.ts";
import { harness } from "../../lib/harness.ts";
test("inbox messages reach the session as readable notifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-extension-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = harness(); install(h.pi);
  h.ctx.isIdle = () => false;
  try {
    await h.command("swarm:start", "Build the feature");
    const identity = h.entries.at(-1).data;
    const store = new SwarmStore(join(root, "swarm"));
    const child = await store.reserve(identity.run, identity.node, "Worker", "Build a part");
    await store.send(identity.run, child.id, identity.node, "message", "Result ready for review.");

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (h.sentMessages.length && (await store.inbox(identity.run, identity.node)).length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0]).toEqual({
      message: {
        customType: "swarm-message",
        content: `Swarm message from Worker (${child.id}):\nResult ready for review.`,
        display: true,
        details: { runId: identity.run, messageId: expect.any(String), from: child.id, kind: "message" },
      },
      options: { triggerTurn: true, deliverAs: "steer" },
    });
    expect(await store.inbox(identity.run, identity.node)).toEqual([]);
  } finally {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test("workers pause after completion and resume only after parent review", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-extension-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = harness(); install(h.pi);
  const store = new SwarmStore(join(root, "swarm"));
  try {
    const run = await store.create("parent-session", root, "Build the feature");
    const child = await store.reserve(run.id, run.root, "Worker", "Build a part");
    await store.update(run.id, state => { state.nodes[child.id].status = "running"; });
    h.pi.appendEntry("pi:swarm", { run: run.id, node: child.id });
    await h.emit("session_start");
    h.ctx.isIdle = () => false;

    const sibling = await store.reserve(run.id, run.root, "Peer", "Related part");
    const assignment = (await h.call("swarm_task", {})).details;
    expect(assignment.parent).toMatchObject({ id: run.root, name: "root", cwd: root });
    expect(assignment.siblings).toEqual([{ id: sibling.id, name: "Peer", status: "starting" }]);
    const [prompt] = await h.emit("before_agent_start");
    expect(prompt.systemPromptOptions.promptGuidelines.join("\n")).toContain("handoff must stand alone");
    expect(prompt.systemPromptOptions.promptGuidelines.join("\n")).toContain("Commit only when authorized");
    await store.send(run.id, run.root, child.id, "instruction", "Hand off now.");
    const deadline = Date.now() + 3000;
    while (!h.sentMessages.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(h.sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(h.sentMessages[0].message.content).toContain("Hand off now.");
    // Wait for durable acknowledgment before the next state update.
    while ((await store.inbox(run.id, child.id)).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(await h.emit("tool_call", { toolName: "bash" })).toEqual([undefined]);

    expect(h.tools.get("swarm_complete").exposure).toBe("model-only");
    const completed = await h.call("swarm_complete", { result: "Verified result" });
    expect(completed.terminate).toBe(true);
    expect(completed.details.status).toBe("review");
    expect((await store.inbox(run.id, run.root))[0].text).toContain(`swarm_tree nodeId=${child.id}`);
    for (const toolName of ["bash", "write", "swarm_send"]) {
      expect(await h.emit("tool_call", { toolName })).toEqual([{
        block: true, terminate: true, reason: "Swarm worker is review; tools are paused until the parent resumes it.",
      }]);
    }

    await store.send(run.id, run.root, child.id, "message", "Wait for review.");
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(h.sentMessages).toHaveLength(1);
    expect(await store.inbox(run.id, child.id)).toHaveLength(1);

    await store.review(run.id, run.root, child.id, "request-changes", "Fix one check");
    await store.send(run.id, run.root, child.id, "instruction", "Fix one check");
    const resumed = Date.now() + 3000;
    while ((await store.inbox(run.id, child.id)).length && Date.now() < resumed) await new Promise(resolve => setTimeout(resolve, 25));
    expect(h.sentMessages).toHaveLength(3);
    expect(h.sentMessages.slice(1).every(message => message.options.deliverAs === "steer")).toBe(true);
    expect(await h.emit("tool_call", { toolName: "write" })).toEqual([undefined]);

    for (const status of ["accepted", "rejected", "stopped", "failed"] as const) {
      await store.update(run.id, state => { state.nodes[child.id].status = status; });
      expect((await h.emit("tool_call", { toolName: "bash" }))[0]).toMatchObject({ block: true, terminate: true });
    }
  } finally {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("swarm activation is user-only, session-bound, and exposes all tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-extension-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = harness();
  try {
    install(h.pi); expect(h.tools.size).toBe(13);
    await expect(h.call("swarm_task", {})).rejects.toThrow("inactive");
    expect(await h.emit("before_agent_start")).toEqual([undefined]);
    await h.command("swarm:start", "Build the feature");
    const [prompt] = await h.emit("before_agent_start", { systemPromptOptions: { sections: { test: "keep" }, promptGuidelines: ["Existing rule"] } });
    expect(prompt.systemPromptOptions.sections).toEqual({ test: "keep" });
    expect(prompt.systemPromptOptions.promptGuidelines[0]).toBe("Existing rule");
    expect(prompt.systemPromptOptions.promptGuidelines.join("\n")).toContain("swarm_broadcast");
    expect((await h.call("swarm_task", {})).details.objective).toBe("Build the feature");
    const identity = h.entries.at(-1).data;
    const store = new SwarmStore(join(root, "swarm"));
    const worker = await store.reserve(identity.run, identity.node, "Worker", "Long assignment ".repeat(100));
    const done = await store.reserve(identity.run, identity.node, "Done", "Finished task");
    await store.update(identity.run, run => {
      run.nodes[worker.id].status = "review";
      run.nodes[worker.id].result = "Detailed handoff ".repeat(100);
      run.nodes[done.id].status = "accepted";
    });
    const snapshot = (await h.call("swarm_tree", {})).details;
    expect(snapshot).toMatchObject({ active: 1, finished: 1 });
    expect(snapshot.nodes.map((node: any) => node.id)).toEqual([identity.node, worker.id]);
    expect(snapshot.nodes[1].task.length).toBeLessThanOrEqual(241);
    expect(snapshot.nodes[1].hasResult).toBe(true);
    expect(snapshot.nodes[1].result).toBeUndefined();
    expect((await h.call("swarm_tree", { includeTerminal: true })).details.nodes).toHaveLength(3);
    expect((await h.call("swarm_tree", { nodeId: worker.id })).details.result).toBe("Detailed handoff ".repeat(100));
    expect((await h.call("swarm_tree", { nodeId: done.id })).details.status).toBe("accepted");
    await expect(h.call("swarm_tree", { nodeId: "unknown" })).rejects.toThrow("Unknown");
    expect((await h.call("swarm_broadcast", { kind: "instruction", text: "Finish this step" })).details).toEqual({ recipients: [worker.id], count: 1 });
    expect((await store.inbox(identity.run, worker.id))[0].text).toBe("Finish this step");
    await expect(h.command("swarm:start", "Again")).rejects.toThrow("already");
    h.ctx.sessionManager.getSessionId = () => "other";
    await expect(h.call("swarm_tree", {})).rejects.toThrow("another root session");
    h.ctx.sessionManager.getSessionId = () => "test-session";
    await h.call("swarm_clear", {});
    await expect(h.call("swarm_task", {})).rejects.toThrow("inactive");
  } finally {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test("/swarm:kill stops workers and /swarm:status toggles the panel", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-extension-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = harness(); install(h.pi);
  const widgets: any[] = []; const notices: string[] = [];
  h.ctx.ui.setWidget = (key: string, content: any, options: any) => widgets.push({ key, content, options });
  h.ctx.ui.notify = (message: string) => notices.push(message);
  try {
    await expect(h.command("swarm:status")).rejects.toThrow("inactive");
    await expect(h.command("swarm:kill")).rejects.toThrow("inactive");
    await h.command("swarm:start", "Build the feature");
    const identity = h.entries.at(-1).data;
    const store = new SwarmStore(join(root, "swarm"));
    const child = await store.reserve(identity.run, identity.node, "Worker", "Build a part");

    await h.command("swarm:status");
    expect(widgets.at(-1)).toMatchObject({ key: "swarm", options: { placement: "belowEditor" } });
    const renders: number[] = [];
    const component = widgets.at(-1).content({ requestRender: () => renders.push(1) }, { fg: (_: string, text: string) => text });
    await h.command("swarm:kill");
    expect((await store.read(identity.run)).nodes[child.id].status).toBe("stopped");
    expect(notices.at(-1)).toBe("Stopped 1 swarm worker. Worktrees, sessions and branches are kept.");
    expect(renders.length).toBeGreaterThan(0);
    expect(component.render(120)).toEqual(["swarm · 0 active · 1 finished · Build the feature", "  No active workers"]);
    await h.command("swarm:kill");
    expect(notices.at(-1)).toBe("No swarm workers are active.");

    await h.command("swarm:status");
    expect(widgets.at(-1)).toEqual({ key: "swarm", content: undefined, options: undefined });
  } finally {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
