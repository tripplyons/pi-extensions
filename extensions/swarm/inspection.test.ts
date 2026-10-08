import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";
import { SwarmStore } from "./state.ts";
import { Workers } from "./worker.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function reply(session: SessionManager, text: string) {
  return session.appendMessage({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "test", usage, stopReason: "stop", timestamp: Date.now() });
}
async function fixture(check: (h: ReturnType<typeof harness>, store: SwarmStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-inspection-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const h = harness(); h.ctx.cwd = root; h.ctx.mode = "tui"; h.ctx.isIdle = () => false;
  install(h.pi);
  try { await check(h, new SwarmStore(join(root, "swarm")), root); }
  finally { await h.emit("session_shutdown"); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}

async function retainedWorker(h: ReturnType<typeof harness>, store: SwarmStore, root: string) {
  await h.command("swarm:start", "Inspect work");
  const identity = h.entries.find(entry => entry.customType === "pi:swarm").data;
  const worker = await store.reserve(identity.run, identity.node, "Builder", "Original task");
  const session = SessionManager.create(join(root, "workspace"), join(root, "worker-sessions"));
  const ids = Array.from({ length: 30 }, (_, i) => reply(session, `Saved response ${i}`));
  await store.update(identity.run, run => { Object.assign(run.nodes[worker.id], { status: "stopped", session: session.getSessionFile(),
    result: "Built the feature. Tests passed at pinned base.", handoff: { revision: 2, status: "accepted" },
    directive: { text: "Updated bounded task", source: "parent", created: new Date().toISOString() }, assignmentGeneration: 3,
    permission: { status: "waiting-approval", reason: "Waiting for a decision", source: "parent", updated: new Date().toISOString() },
    delivery: [{ revision: "a".repeat(40), tested: { actor: identity.node, text: "Focused checks passed", recorded: new Date().toISOString() } }],
  }); });
  return { identity, worker, session, ids };
}

test("swarm_inspect reads retained sessions without a pane and keeps live state separate from historical evidence", () => fixture(async (h, store, root) => {
  const { identity, worker, session, ids } = await retainedWorker(h, store, root);
  const observe = Workers.prototype.observe; Workers.prototype.observe = async () => { throw new Error("No pane"); };
  try {
    const statePath = join(store.path(identity.run), "run.json"), originalState = await readFile(statePath, "utf8"), originalSession = await readFile(session.getSessionFile()!, "utf8");
    const output = await h.call("swarm_inspect", { nodeId: worker.id, limit: 5 });
    expect(output.details).toMatchObject({ nodeId: worker.id, status: "stopped", permission: { status: "waiting-approval" },
      assignment: { generation: 3, text: { text: "Updated bounded task" } }, handoff: { revision: 2, status: "accepted" }, conversationError: null });
    expect(output.details.conversation.records.map((item: any) => item.entryId)).toEqual(ids.slice(-5));
    const older = (await h.call("swarm_inspect", { nodeId: worker.id, limit: 5, beforeEntryId: output.details.conversation.nextBeforeEntryId })).details;
    expect(older.conversation.records.map((item: any) => item.entryId)).toEqual(ids.slice(-10, -5));
    expect(output.details.delivery[0].reviewed).toBeUndefined(); expect(output.details.delivery[0].integrated).toBeUndefined();
    expect(output.details.notice).toContain("not current instructions or permission");
    expect(await readFile(statePath, "utf8")).toBe(originalState);
    expect(await readFile(session.getSessionFile()!, "utf8")).toBe(originalSession);
    expect(h.tools.get("swarm_inspect").annotations.readOnlyHint).toBe(true);
  } finally { Workers.prototype.observe = observe; }
}));

test("worker inspection has same-run access, requires activation, rejects root IDs, and retains handoffs when sessions disappear", () => fixture(async (h, store, root) => {
  await expect(h.call("swarm_inspect", { nodeId: "unknown" })).rejects.toThrow("inactive");
  const { identity, worker, session } = await retainedWorker(h, store, root);
  await expect(h.call("swarm_inspect", { nodeId: "__proto__" })).rejects.toThrow("Unknown node");
  await expect(h.call("swarm_inspect", { nodeId: identity.node })).rejects.toThrow("not the root");
  await expect(h.call("swarm_inspect", { nodeId: worker.id, beforeEntryId: "unknown" })).rejects.toThrow("beforeEntryId");
  const otherRun = await store.create("other-session", root, "Other run");
  const outside = await store.reserve(otherRun.id, otherRun.root, "Outside", "Other work");
  await expect(h.call("swarm_inspect", { nodeId: outside.id })).rejects.toThrow("Unknown node");
  await rm(session.getSessionFile()!);
  const missing = (await h.call("swarm_inspect", { nodeId: worker.id })).details;
  expect(missing.conversation).toBeNull(); expect(missing.conversationError).toContain("ENOENT");
  expect(missing.handoff.result.text).toContain("Tests passed");
  const fresh = await store.reserve(identity.run, identity.node, "Starting", "Task");
  expect((await h.call("swarm_inspect", { nodeId: fresh.id })).details.conversationError).toContain("not saved");
  const signal = new AbortController(); signal.abort();
  await expect(h.call("swarm_inspect", { nodeId: worker.id }, signal.signal)).rejects.toThrow();
}));

test("workers can inspect peers across branches on a permission hold without managing or releasing them", () => fixture(async (h, store, root) => {
  const { identity, worker } = await retainedWorker(h, store, root);
  const actor = await store.reserve(identity.run, identity.node, "Inspector", "Read peer work");
  await store.update(identity.run, run => { Object.assign(run.nodes[actor.id], { status: "running", permission: { status: "checkpoint-hold", source: "parent", reason: "Reload", updated: new Date().toISOString() }, reload: { barrier: "test", stage: "checkpointed" } }); });
  h.pi.appendEntry("pi:swarm", { run: identity.run, node: actor.id });
  await h.emit("session_start");
  for (const toolName of ["swarm_inspect", "session_search", "session_read"]) {
    expect(await h.emit("tool_call", { toolName, input: { nodeId: worker.id } })).toEqual([undefined]);
    expect((await store.read(identity.run)).nodes[actor.id].permission?.status).toBe("checkpoint-hold");
  }
  expect((await h.call("swarm_inspect", { nodeId: worker.id })).details.nodeId).toBe(worker.id);
  expect((await h.emit("tool_call", { toolName: "swarm_review", input: {} }))[0]).toMatchObject({ block: true, terminate: true });
  const target = (await store.read(identity.run)).nodes[worker.id];
  expect(target.permission?.status).toBe("waiting-approval"); expect(target.handoff?.status).toBe("accepted");
}));

test("interactive worker inspection browses retained logs and handoffs, refreshes, pages older, and does not inject messages", () => fixture(async (h, store, root) => {
  const { identity, worker } = await retainedWorker(h, store, root);
  const selections: Array<string | undefined> = ["Conversation", "Handoff and code evidence", undefined];
  const actions = ["p", "r", "\x1b", "\x1b"];
  const bodies: string[] = [];
  h.ctx.ui.select = async (title: string, choices: string[]) => title.startsWith("Inspect worker") ? choices[0] : selections.shift();
  h.ctx.ui.custom = async (factory: any) => {
    let action;
    const component = factory({ terminal: { rows: 100 }, requestRender() {} }, { fg: (_color: string, value: string) => value }, {}, (value: any) => { action = value; });
    bodies.push(component.render(100).join("\n")); component.handleInput(actions.shift()!); return action;
  };
  const statePath = join(store.path(identity.run), "run.json"), originalState = await readFile(statePath, "utf8");
  const sent = h.sentMessages.length;
  await h.command("swarm:inspect", worker.id);
  expect(bodies).toHaveLength(4);
  expect(bodies[0]).toContain("Saved response 29");
  expect(bodies[1]).toContain("Saved response 0"); expect(bodies[2]).toContain("Saved response 0");
  expect(bodies[3]).toContain("Handoff revision 2, accepted");
  expect(await readFile(statePath, "utf8")).toBe(originalState);
  expect(h.sentMessages).toHaveLength(sent); expect(h.sent).toEqual([]);
}));

test("worker conversation inspector opens entries and expands saved summaries into original evidence", () => fixture(async (h, store, root) => {
  const { worker, session, ids } = await retainedWorker(h, store, root);
  session.appendCompaction("Summary of the earlier work", ids.at(-1)!, 10000);
  const actions = ["o", "e", "\u001b"], bodies: string[] = [];
  let menu = 0;
  h.ctx.ui.select = async (title: string, choices: string[]) => title === "Open conversation entry"
    ? choices.find(choice => choice.includes("compaction")) : menu++ === 0 ? "Conversation" : undefined;
  h.ctx.ui.custom = async (factory: any) => {
    let action;
    const component = factory({ terminal: { rows: 100 }, requestRender() {} }, { fg: (_color: string, value: string) => value }, {}, (value: any) => { action = value; });
    bodies.push(component.render(100).join("\n")); component.handleInput(actions.shift()!); return action;
  };
  await h.command("swarm:inspect", worker.id);
  expect(bodies).toHaveLength(3);
  expect(bodies[1]).toContain("e expand summary");
  expect(bodies[2]).toContain("Saved response 28");
  expect(bodies[2]).not.toContain("Saved response 29");
  expect(bodies[2]).not.toContain("Summary of the earlier work");
}));

test("terminal inspection reports a missing pane without falling back to execution; non-TUI mode is guarded", () => fixture(async (h, store, root) => {
  const { worker } = await retainedWorker(h, store, root);
  const observe = Workers.prototype.observe; let calls = 0, body = "";
  Workers.prototype.observe = async (_nodeId, lines) => { calls++; expect(lines).toBe(200); throw new Error("No pane"); };
  let selected = false;
  h.ctx.ui.select = async () => selected ? undefined : (selected = true, "Terminal output");
  h.ctx.ui.custom = async (factory: any) => {
    let action;
    const component = factory({ terminal: { rows: 20 }, requestRender() {} }, { fg: (_color: string, value: string) => value }, {}, (value: any) => { action = value; });
    body = component.render(80).join("\n"); component.handleInput("\x1b"); return action;
  };
  try {
    await h.command("swarm:inspect", worker.id);
    expect(body).toContain("Terminal output unavailable"); expect(calls).toBe(1);
    h.ctx.mode = "rpc"; await h.command("swarm:inspect", worker.id); expect(calls).toBe(1);
  } finally { Workers.prototype.observe = observe; }
}));
