import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import minimax from "./index.ts";
import { Tasks } from "./tasks.ts";
import { mkdtempSync } from "node:fs";
import { harness } from "../../lib/harness.ts";
import { Archive, archiveMessages, capToolOutput, maxInlineBytes } from "./archive.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(join(tmpdir(), "minimax-test-")); roots.push(root); return root; }
const baseline = ["read", "shell", "search", "list", "view_image", "bg_process", "sleep", "ask_user", "complain", "get_goal", "swarm_task"];
function setup() {
  const h = harness();
  let active = [...baseline, "edit", "write", "bash", "grep", "glob", "todo_write", "archive_read"];
  h.pi.getActiveTools = () => [...active];
  h.pi.setActiveTools = (names: string[]) => { active = [...names]; };
  h.ctx.isIdle = () => true;
  h.ctx.getContextUsage = () => undefined;
  h.pi.sendMessage = (message: any) => h.sent.push(message.content);
  const taskRoot = mkdtempSync(join(tmpdir(), "minimax-tasks-")); roots.push(taskRoot);
  minimax(h.pi, new Tasks(taskRoot));
  return { ...h, active: () => active };
}
function messages(rounds = 8, size = 40_000): any[] {
  return Array.from({ length: rounds }, (_, i) => [
    { role: "assistant", content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: "a.ts", offset: 1, limit: 1000 } }], timestamp: i },
    { role: "toolResult", toolCallId: `call-${i}`, toolName: "read", content: [{ type: "text", text: `${i}:` + "🙂".repeat(size) }], isError: false, timestamp: i },
  ]).flat();
}

test("MiniMax is always active, ignores old toggles and preserves companion activation", async () => {
  const h = setup();
  h.pi.appendEntry("rework:minimax", { enabled: false });
  await h.emit("session_start");
  expect(h.commands.has("minimax")).toBe(false);
  expect(h.active().sort()).toEqual(["read", "edit", "write", "grep", "glob", "bash", "task_query", "task_output", "task_stop", "todo_write", "archive_read", "ask_user", "complain", "get_goal", "swarm_task"].sort());
  expect(h.tools.get("read").parameters.properties.offset.minimum).not.toBe(0);
  for (const name of ["shell", "bg_process", "sleep", "unknown_tool"]) {
    expect((await h.emit("tool_call", { toolName: name }))[0].block).toBe(true);
  }
  for (const name of ["read", "bash", "ask_user", "complain", "get_goal", "swarm_task", "run_experiment"]) {
    expect(await h.emit("tool_call", { toolName: name })).toEqual([undefined]);
  }
  for (const event of ["session_switch", "session_fork", "session_tree"]) {
    await h.emit(event);
    expect(h.active()).toContain("bash");
    expect(h.active()).not.toContain("shell");
  }
});

test("todos follow the active session branch, including reload", async () => {
  const h = setup(); await h.emit("session_start");
  const todos = [{ id: "a", content: "Verify the change", status: "in_progress" }];
  await h.call("todo_write", { todos });
  const branch = structuredClone(h.entries);
  h.entries.length = 0; await h.emit("session_switch");
  expect(h.active()).not.toContain("shell"); expect(h.active()).toContain("todo_write");
  expect((await h.emit("before_agent_start", { systemPrompt: "base" })).at(-1).systemPrompt).not.toContain("Verify the change");
  h.entries.push(...branch); await h.emit("session_tree");
  expect(h.active()).toContain("todo_write");
  const prompt = (await h.emit("before_agent_start", { systemPrompt: "base" })).find(value => value?.systemPrompt);
  expect(prompt.systemPrompt).toContain("Verify the change");
  const fresh = setup(); fresh.entries.push(...branch); await fresh.emit("session_start");
  expect(fresh.active()).toContain("bash");
});

test("native file tools perform line reads, edits, writes, regex search, globs and bash", async () => {
  const h = setup(); h.ctx.cwd = await temp(); await h.emit("session_start");
  await h.call("write", { path: "example.txt", content: "first\nsecond\nthird\n" });
  expect((await h.call("read", { path: "example.txt", offset: 2, limit: 1 })).content[0].text).toContain("second");
  await h.call("edit", { path: "example.txt", edits: [{ oldText: "second", newText: "changed" }] });
  expect(await readFile(join(h.ctx.cwd, "example.txt"), "utf8")).toBe("first\nchanged\nthird\n");
  expect((await h.call("grep", { path: ".", pattern: "ch.nged" })).content[0].text).toContain("changed");
  expect((await h.call("glob", { path: ".", pattern: "*.txt" })).content[0].text).toContain("example.txt");
  expect((await h.call("bash", { command: "printf verified", timeout: 2 })).content[0].text).toBe("verified");
  await expect(h.call("read", { path: "." })).rejects.toThrow("Not a regular file");
  await expect(h.call("read", { path: "example.txt", offset: 0 })).rejects.toThrow("positive line");
});

test("Bash passes upstream timeout defaults and cap to the executor", async () => {
  const received: (number | undefined)[] = [];
  const tasks = new Tasks(await temp(), {
    async exec(_command, _cwd, options) {
      received.push(options.timeout);
      options.onData(Buffer.from("verified"));
      return { exitCode: 0 };
    },
  });
  for (const timeout of [undefined, 0, -1, NaN, Infinity, 0.25, 120, 300, 301, 1e10]) {
    expect((await tasks.run(process.cwd(), { command: "ignored", timeout }, undefined, () => {}, () => {})).content[0]).toEqual({ type: "text", text: "verified" });
  }
  expect(received).toEqual([120, 120, 120, 120, 120, 0.25, 120, 300, 300, 300]);
  const h = setup(); await h.emit("session_start");
  const registered = h.tools.get("bash");
  expect(registered.parameters.properties.timeout.description).toContain("defaults to 120");
  expect(registered.description).not.toContain("no default timeout");
  await expect(h.call("bash", { command: "sleep 5", timeout: 0.05 })).rejects.toThrow("Command timed out after 0.05 seconds");
});

test("archiver preserves five rounds, arguments, original output, and bounded retrieval", async () => {
  const archive = new Archive(await temp()); const input = messages(); const snapshot = structuredClone(input);
  const projected = await archiveMessages(input, [], archive);
  expect(projected.added).toHaveLength(3);
  expect(input).toEqual(snapshot);
  expect(projected.messages.slice(6)).toEqual(input.slice(6));
  expect(projected.messages[0]).toEqual(input[0]);
  expect(JSON.parse(await archive.read(projected.added[0].id))).toEqual(input[1]);
  expect((await archiveMessages(input, projected.added, archive)).added).toHaveLength(0);
  const h = setup();
  // Retrieval is branch-scoped; use a temporary state root for the extension's store.
  const artifact = projected.added[0];
  await expect(h.call("archive_read", { id: artifact.id, offset: 0, limit: 20 })).rejects.toThrow("not on this session branch");
  await rm(join(archive.root, `${artifact.id}.json`));
  const missing = await archiveMessages(input, projected.added, archive);
  expect(missing.messages[1]).toEqual(input[1]);
  await expect(archive.read("../bad")).rejects.toThrow("Invalid archive");
});

test("small histories and the five most recent rounds are never archived", async () => {
  const archive = new Archive(await temp());
  expect((await archiveMessages(messages(8, 100), [], archive)).added).toHaveLength(0);
  expect((await archiveMessages(messages(5), [], archive)).added).toHaveLength(0);
});

function compactionEvent() {
  return { signal: new AbortController().signal, customInstructions: "Keep the test command", preparation: {
    messagesToSummarize: [{ role: "user", content: "Fix the bug", timestamp: 0 }],
    turnPrefixMessages: [{ role: "user", content: "Split-turn context", timestamp: 1 }],
    previousSummary: "Previous checkpoint", tokensBefore: 110000, firstKeptEntryId: "keep-me",
  } };
}

test("structured compaction includes split turns, previous checkpoint, exact stored todos and usage", async () => {
  const h = setup(); await h.emit("session_start");
  const todos = [{ id: "x", content: "Run npm test", status: "pending" }];
  await h.call("todo_write", { todos });
  let request: any, options: any;
  const usage = { input: 100, output: 50 };
  h.ctx.model = { provider: "openai-codex", id: "test", maxTokens: 16384 };
  h.ctx.modelRegistry = { complete: async (_model: unknown, context: unknown, opts: unknown) => {
    request = context; options = opts;
    return { content: [{ type: "text", text: "## Current state\nChanged src/a.ts; not tested." }], stopReason: "stop", usage };
  } };
  const [response] = await h.emit("session_before_compact", compactionEvent());
  expect(request.messages[0].content).toContain("Split-turn context");
  expect(request.messages[0].content).toContain("Previous checkpoint");
  expect(request.messages[1].content).toContain("Keep the test command");
  expect(request.systemPrompt).toContain("Do not invent completion");
  expect(options.cacheRetention).toBe("none");
  expect(response.compaction.firstKeptEntryId).toBe("keep-me");
  expect(response.compaction.summary).toContain(JSON.stringify(todos));
  expect(response.compaction.details.todos).toEqual(todos);
  expect(response.compaction.usage).toEqual(usage);
});

test("failed, truncated, empty and aborted checkpoints never replace the session", async () => {
  const h = setup(); await h.emit("session_start");
  h.ctx.model = { maxTokens: 8192 };
  for (const stopReason of ["error", "aborted", "length", "stop"]) {
    h.ctx.modelRegistry = { complete: async () => ({ content: [], stopReason }) };
    expect(await h.emit("session_before_compact", compactionEvent())).toEqual([{ cancel: true }]);
  }
  h.ctx.modelRegistry = { complete: async () => { throw new Error("Network failure"); } };
  expect(await h.emit("session_before_compact", compactionEvent())).toEqual([{ cancel: true }]);
});

test("/threshold controls MiniMax automatic compaction and does not block manual or overflow recovery", async () => {
  const h = setup();
  await h.emit("session_start");
  await h.command("threshold", "60k");
  let tokens: number | null = 59999, calls = 0;
  h.ctx.getContextUsage = () => ({ tokens });
  h.ctx.compact = (options: any) => { calls++; options.onComplete({}); };
  await h.emit("agent_settled"); expect(calls).toBe(0);
  tokens = 60000; await h.emit("agent_settled"); expect(calls).toBe(1);
  await h.command("threshold", "200k");
  await h.emit("agent_settled"); expect(calls).toBe(1);
  tokens = 200000; await h.emit("agent_settled"); expect(calls).toBe(2);
  tokens = null; await h.emit("agent_settled"); expect(calls).toBe(2);
  h.ctx.model = { maxTokens: 8192 };
  let summaries = 0;
  h.ctx.modelRegistry = { complete: async () => { summaries++; return { content: [{ type: "text", text: "checkpoint" }], stopReason: "stop" }; } };
  expect((await h.emit("session_before_compact", { ...compactionEvent(), reason: "threshold" }))[0]).toEqual({ cancel: true });
  expect(summaries).toBe(0);
  for (const reason of ["manual", "overflow"]) {
    expect((await h.emit("session_before_compact", { ...compactionEvent(), reason }))[0].compaction.summary).toContain("checkpoint");
  }
  expect(summaries).toBe(2);
});

test("upstream byte policy uses strict net-savings gate, not gross bytes or tokens", async () => {
  const archive = new Archive(await temp());
  const history = (size: number) => {
    const input = messages(6, 0);
    input[1].content = [{ type: "text", text: "x".repeat(size) }];
    return input;
  };
  for (const size of [262144, 262144 + 512]) {
    expect((await archiveMessages(history(size), [], archive)).added).toHaveLength(0);
  }
  expect((await archiveMessages(history(262144 + 513), [], archive)).added).toHaveLength(1);
});

test("policy protects errors, control results and incomplete rounds", async () => {
  const archive = new Archive(await temp());
  for (const name of ["skill", "ask_user", "todo_write", "TodoWrite", "create_goal", "enterplanmode", "archive_read"]) {
    const input = messages();
    input[0].content[0].name = name;
    expect((await archiveMessages(input, [], archive)).added.map(item => item.toolCallId)).not.toContain("call-0");
  }
  const input = messages(); input[1].isError = true;
  expect((await archiveMessages(input, [], archive)).added.map(item => item.toolCallId)).not.toContain("call-0");
  const incomplete = messages(9); incomplete.pop();
  const projected = await archiveMessages(incomplete, [], archive);
  expect(projected.added.map(item => item.toolCallId)).toEqual(["call-0", "call-1", "call-2"]);
  // A partial parallel round must not archive even its completed result.
  incomplete.at(-1).content.push({ type: "toolCall", id: "extra", name: "read", arguments: {} });
  incomplete.push({ ...messages()[1], toolCallId: "call-8" });
  expect((await archiveMessages(incomplete, [], archive)).added.map(item => item.toolCallId)).toEqual(["call-0", "call-1", "call-2"]);
});

test("reminders enter only existing requests and persist branch-local cadence", async () => {
  const h = setup(); await h.emit("session_start");
  h.ctx.model = { contextWindow: 200000, maxTokens: 8192 };
  h.ctx.getSystemPrompt = () => "test system";
  h.pi.getAllTools = () => [...h.tools.values()];
  await h.call("todo_write", { todos: [{ id: "a", content: "Verify", status: "pending" }] });
  for (let i = 0; i < 15; i++) h.entries.push({ type: "message", message: { role: "assistant", stopReason: "toolUse" } });
  const before = structuredClone(h.entries);
  const context = { messages: [{ role: "user", content: "Continue", timestamp: 0 }] };
  const output = (await h.emit("context", context)).at(-1);
  expect(output.messages.at(-1).content).toContain("15 assistant iterations");
  expect(context.messages).toHaveLength(1); expect(h.sent).toEqual([]);
  expect((await h.emit("context", context)).at(-1).messages).toHaveLength(1);
  const reload = setup(); reload.entries.push(...structuredClone(h.entries));
  reload.ctx.model = h.ctx.model; reload.ctx.getSystemPrompt = h.ctx.getSystemPrompt; reload.pi.getAllTools = h.pi.getAllTools;
  await reload.emit("session_start");
  expect((await reload.emit("context", context)).at(-1).messages).toHaveLength(1);
  h.entries.splice(0, h.entries.length, ...before);
  h.ctx.model.contextWindow = 10;
  expect((await h.emit("context", context)).at(-1).messages).toHaveLength(1);
  expect(h.entries).toEqual(before); // A rejected reminder does not reset cadence.
  h.ctx.model.contextWindow = 200000;
  h.ctx.signal = AbortSignal.abort();
  expect((await h.emit("context", context)).at(-1).messages).toHaveLength(1);
  expect(h.entries).toEqual(before);
  h.ctx.signal = undefined;
  await h.call("todo_write", { todos: [{ id: "a", content: "Verify", status: "completed" }] });
  for (let i = 0; i < 20; i++) h.entries.push({ type: "message", message: { role: "assistant", stopReason: "stop" } });
  expect((await h.emit("context", context)).at(-1).messages).toHaveLength(1);
  expect(h.sent).toEqual([]);
});

test("loop reminder is request-local, deduplicated and never triggers continuation", async () => {
  const h = setup(); await h.emit("session_start");
  h.ctx.model = { contextWindow: 200000, maxTokens: 8192 };
  h.ctx.getSystemPrompt = () => "test"; h.pi.getAllTools = () => [...h.tools.values()];
  const repeated = messages(3, 1);
  for (const message of repeated) if (message.role === "toolResult") { message.isError = true; message.content = [{ type: "text", text: "missing file" }]; }
  const output = (await h.emit("context", { messages: repeated })).at(-1);
  expect(output.messages.at(-1).content).toContain("MiniMax loop reminder");
  expect((await h.emit("context", { messages: repeated })).at(-1).messages).toHaveLength(repeated.length);
  expect(h.sent).toEqual([]);
});

test("rejected archive admission preserves earlier receipts without publishing new ones", async () => {
  const archive = new Archive(await temp());
  const input = messages(9);
  const known = [await archive.save(input[1])];
  let checked = false;
  const output = await archiveMessages(input, known, archive, (before, after) => {
    checked = true; expect(before[1].content[0].text).toContain("minimax archive");
    expect(after[3].content[0].text).toContain("minimax archive"); return false;
  });
  expect(checked).toBe(true); expect(output.added).toEqual([]);
  expect(output.messages[1].content[0].text).toContain("minimax archive");
  expect(output.messages[3]).toEqual(input[3]);
});


test("MiniMax does not activate ask_user when it was unavailable", async () => {
  const h = setup(); await h.emit("session_start");
  h.pi.setActiveTools(h.active().filter(name => name !== "ask_user"));

  expect(h.active()).not.toContain("ask_user");
  await h.emit("session_tree");
  expect(h.active()).not.toContain("ask_user");
});


test("result cap measures UTF-8 text and preserves errors, images, and original artifacts", async () => {
  const archive = new Archive(await temp());
  const output = messages(1, 0)[1];
  output.content = [{ type: "text", text: "🙂".repeat(maxInlineBytes / 4) }];
  expect(await capToolOutput(output, archive)).toBeUndefined();
  output.content[0].text += "x";
  output.content.push({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  output.isError = true;
  output.details = { diagnostic: "retained" };
  const snapshot = structuredClone(output);
  const capped = await capToolOutput(output, archive);
  expect(capped!.output.content[0].text).toStartWith("Tool failed. [minimax archive ");
  expect(capped!.output.content[1]).toEqual(output.content[1]);
  expect(capped!.output.isError).toBe(true);
  expect(capped!.output.details).toEqual(output.details);
  expect(JSON.parse(await archive.read(capped!.artifact.id))).toEqual(snapshot);
  expect(output).toEqual(snapshot);
  for (const toolName of ["ask_user", "todo_write", "create_goal", "archive_read"]) {
    expect(await capToolOutput({ ...output, toolName }, archive)).toBeUndefined();
  }
  const broken = new Archive(join(await temp(), "not-a-directory"));
  await writeFile(broken.root, "file");
  await expect(capToolOutput(output, broken)).rejects.toThrow();
  expect(output).toEqual(snapshot);
});

test("result cap is always active and its durable receipt remains retrievable after reload", async () => {
  const h = setup(); await h.emit("session_start");
  const output = messages(1)[1];

  const [capped] = await h.emit("tool_result", output);
  expect(capped.content[0].text).toContain("[minimax archive ");
  const artifact = h.entries.find(entry => entry.customType === "rework:minimax-archive").data[0];
  await h.emit("session_start");
  const retrieved = await h.call("archive_read", { id: artifact.id, offset: 0, limit: 32000 });
  expect(retrieved.details.content).toContain(output.content[0].text.slice(0, 100));
  expect(retrieved.details.nextOffset).toBe(32000);
});

test("automatic checkpoint admission measures retained history; manual and overflow still summarize", async () => {
  const h = setup();
  h.pi.appendEntry("rework:codex-compaction", { threshold: 100_000 }); await h.emit("session_start");
  h.ctx.model = { contextWindow: 200000, maxTokens: 8192 };
  h.ctx.getSystemPrompt = () => "test";
  h.pi.getAllTools = () => [...h.tools.values()];
  let summaries = 0;
  h.ctx.modelRegistry = { complete: async () => {
    summaries++; return { content: [{ type: "text", text: "checkpoint" }], stopReason: "stop" };
  } };
  h.ctx.sessionManager.getBranch = () => h.entries.map((entry, i) => ({
    ...entry, id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null,
  }));
  // No tool_result cap ran: archive-first must also work on old session history.
  for (const [i, message] of messages(8, 25000).entries()) {
    h.entries.push({ type: "message", id: `history-${i}`, message });
  }
  const event = { ...compactionEvent(), customInstructions: undefined, reason: "threshold" };
  expect(await h.emit("session_before_compact", event)).toEqual([{ cancel: true }]);
  expect(summaries).toBe(0);
  expect(h.entries.some(entry => entry.customType === "rework:minimax-archive")).toBe(true);
  for (const reason of ["manual", "overflow"]) {
    expect((await h.emit("session_before_compact", { ...event, reason }))[0].compaction).toBeDefined();
  }
  expect(summaries).toBe(2);
  h.entries.push({ type: "message", id: "retained", message: { role: "user", content: "x".repeat(800000), timestamp: 0 } });
  expect((await h.emit("session_before_compact", event))[0].compaction).toBeDefined();
  expect(summaries).toBe(3);
});
