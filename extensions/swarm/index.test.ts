import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import install from "./index.ts";
import { SwarmStore } from "./state.ts";
import { Workers, type Launch } from "./worker.ts";
import { git } from "./git.ts";
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
    const alerts: string[] = [];
    const statuses: Array<string | undefined> = [];
    h.ctx.ui.notify = (text: string) => alerts.push(text);
    h.ctx.ui.setStatus = (key: string, text?: string) => { if (key === "swarm-review") statuses.push(text); };
    await store.update(identity.run, state => { state.nodes[child.id].status = "running"; });
    await store.complete(identity.run, child.id, "Result");
    const alertDeadline = Date.now() + 3000;
    while ((!alerts.length || h.sentMessages.length < 2) && Date.now() < alertDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(alerts).toEqual(["Swarm Worker awaits parent review (handoff revision 1)."]);
    expect(statuses).toContain("swarm: 1 awaiting parent review");
    expect(h.sentMessages[1].message.content).toContain("Awaiting parent review: handoff revision 1");
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(alerts).toHaveLength(1);
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
        block: true, terminate: true, reason: "Swarm pause snapshot: worker was review at this tool check (handoff revision 1). A later parent resume can supersede this snapshot. Check swarm_tree for current state.",
      }]);
    }

    await store.send(run.id, run.root, child.id, "message", "Wait for review.");
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(h.sentMessages).toHaveLength(1);
    expect(await store.inbox(run.id, child.id)).toHaveLength(1);

    await store.review(run.id, run.root, child.id, "request-changes", "Fix one check");
    expect((await store.read(run.id)).nodes[child.id].resume).toMatchObject({ revision: 1, status: "queued" });
    const resumed = Date.now() + 3000;
    while ((await store.inbox(run.id, child.id)).length && Date.now() < resumed) await new Promise(resolve => setTimeout(resolve, 25));
    expect(h.sentMessages).toHaveLength(3);
    expect(h.sentMessages.slice(1).every(message => message.options.deliverAs === "steer")).toBe(true);
    expect((await store.read(run.id)).nodes[child.id].resume?.status).toBe("delivered");
    expect(await h.emit("tool_call", { toolName: "write" })).toEqual([undefined]);
    expect((await store.read(run.id)).nodes[child.id].resume?.status).toBe("observed");
    await h.emit("tool_call", { toolName: "write" });
    expect((await store.inbox(run.id, run.root)).filter(message => message.text.includes("observed at a worker tool boundary"))).toHaveLength(1);

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
    install(h.pi); expect(h.tools.size).toBe(15);
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
test("compact tree exposes current models, exact filtering and independent delivery evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-models-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = harness(); install(h.pi);
  const store = new SwarmStore(join(root, "swarm"));
  try {
    await h.command("swarm:start", "Rotate workers");
    const identity = h.entries.at(-1).data;
    const worker = await store.reserve(identity.run, identity.node, "Worker", "Task");
    await store.update(identity.run, run => { Object.assign(run.nodes[worker.id], {
      status: "running", launch: { model: "anthropic/claude", thinking: "high" },
    }); });
    let snapshot = (await h.call("swarm_tree", { model: "anthropic/claude" })).details;
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({ launch: { model: "anthropic/claude" }, effectiveModel: "anthropic/claude", modelSource: "launch", handoff: "none" });
    await h.call("swarm_replace", { nodeId: worker.id, action: "request" });
    expect((await store.inbox(identity.run, worker.id))[0].text).toContain("Do not auto-commit unverified WIP");
    await expect(h.call("swarm_replace", { nodeId: worker.id, action: "start", name: "Next", task: "Continue" })).rejects.toThrow("requires model");
    h.pi.appendEntry("pi:swarm", { run: identity.run, node: worker.id });
    h.ctx.model = { provider: "openai", id: "gpt-6.1-sol" };
    await h.emit("session_start");
    await h.emit("thinking_level_select", { level: "medium" });
    snapshot = (await h.call("swarm_tree", { model: "openai/gpt-6.1-sol" })).details;
    expect(snapshot.nodes[0]).toMatchObject({ current: { model: "openai/gpt-6.1-sol", thinking: "medium" }, effectiveModel: "openai/gpt-6.1-sol", modelSource: "session" });
    expect((await h.call("swarm_tree", { model: "anthropic/claude" })).details.nodes).toHaveLength(0);
    await h.emit("model_select", { model: { provider: "openai", id: "other" } });
    expect((await store.read(identity.run)).nodes[worker.id].current?.model).toBe("openai/other");
    await h.call("swarm_complete", { result: "Commit plus unverified WIP" });
    h.pi.appendEntry("pi:swarm", identity); await h.emit("session_start");
    snapshot = (await h.call("swarm_tree", {})).details;
    expect(snapshot.nodes.find((node: any) => node.id === worker.id)).toMatchObject({ handoff: "awaiting-parent", code: { records: [] } });
    await store.review(identity.run, identity.node, worker.id, "accept", "Received only");
    const revision = "a".repeat(40);
    await h.call("swarm_record", { nodeId: worker.id, revision, stage: "reviewed", evidence: "Source inspected" });
    snapshot = (await h.call("swarm_tree", { includeTerminal: true })).details;
    expect(snapshot.nodes.find((node: any) => node.id === worker.id)).toMatchObject({ handoff: "accepted", code: { source: "parent-reported", records: [{ revision, reviewed: true, tested: false, integrated: false }] } });
    await expect(h.call("swarm_tree", { nodeId: worker.id, model: "openai/other" })).rejects.toThrow("omit nodeId");
  } finally {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("spawn and replacement inherit the spawning parent's fast preference", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-swarm-fast-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const original = { start: Workers.prototype.start, stop: Workers.prototype.stop, alive: Workers.prototype.alive };
  const launches: Launch[] = [];
  Workers.prototype.start = async options => { launches.push(options); return { pane: options.node, session: join(options.directory, "session.jsonl") }; };
  Workers.prototype.stop = async () => {};
  Workers.prototype.alive = async () => false;
  const h = harness(); install(h.pi);
  try {
    const repo = join(root, "repo"); await git(root, ["init", "-b", "main", repo]);
    await git(repo, ["config", "user.name", "Test"]); await git(repo, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(repo, "file"), "original"); await git(repo, ["add", "."]); await git(repo, ["commit", "-m", "Initial"]);
    const base = await git(repo, ["rev-parse", "HEAD"]);
    h.ctx.cwd = repo; h.ctx.model = { provider: "openai", id: "test-model" };
    await h.command("swarm:start", "Build feature");
    const identity = h.entries.at(-1).data;
    h.pi.appendEntry("pi:fast", true);
    const first = (await h.call("swarm_spawn", { name: "First", task: "Task" })).details;
    expect(launches.at(-1).fast).toBe(true);
    expect(first.launch.fast).toBe(true);
    h.pi.appendEntry("pi:fast", false);
    const second = (await h.call("swarm_spawn", { name: "Second", task: "Task" })).details;
    expect(launches.at(-1).fast).toBe(false);
    const saved = launches.at(-1);
    await h.call("swarm_stop", { nodeId: second.id });
    h.pi.getThinkingLevel = () => "low";
    h.ctx.model = { provider: "openai", id: "parent-model" };
    h.pi.appendEntry("pi:fast", true);
    expect((await h.call("swarm_restart", { nodeId: second.id })).details.thinking).toBe("low");
    expect(launches.at(-1)).toMatchObject({ node: second.id, cwd: saved.cwd, directory: saved.directory, model: "openai/parent-model", fast: true, thinking: "low" });
    await h.call("swarm_stop", { nodeId: second.id });
    h.pi.appendEntry("pi:fast", false);
    h.ctx.model = { provider: "openai", id: "another-parent-model" };
    expect((await h.call("swarm_restart", { nodeId: second.id, thinking: "high" })).details.thinking).toBe("high");
    expect(launches.at(-1)).toMatchObject({ model: "openai/another-parent-model", fast: false, thinking: "high" });
    const store = new SwarmStore(join(root, "swarm"));
    await h.call("swarm_replace", { nodeId: first.id, action: "request" });
    await store.complete(identity.run, first.id, "Accepted task");
    await store.review(identity.run, identity.node, first.id, "accept", "Received");
    const next = (await h.call("swarm_replace", { nodeId: first.id, action: "start", name: "Next", task: "Continue", model: "openai/next-model", testedBase: base })).details;
    expect(next.launch.fast).toBe(false);
    expect(launches.at(-1)).toMatchObject({ model: "openai/next-model", fast: false });
  } finally {
    await h.emit("session_shutdown");
    Object.assign(Workers.prototype, original);
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
    expect(component.render(120)).toEqual(["swarm · 0 active (0 awaiting-parent) · 1 terminal · Build the feature", "  No active workers"]);
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
