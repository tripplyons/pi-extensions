import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import minimax from "./index.ts";
import { Tasks } from "./tasks.ts";
import { mkdtempSync } from "node:fs";
import files from "../files/index.ts";
import pruner from "../context-pruner/index.ts";
import { installCompaction } from "../codex-compaction/index.ts";
import { harness } from "../../lib/harness.ts";
import { Archive, archiveMessages } from "./archive.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(join(tmpdir(), "minimax-test-")); roots.push(root); return root; }
const baseline = ["read", "shell", "search", "list", "view_image", "bg_process", "sleep", "ask_user", "get_goal", "swarm_task"];
function setup() {
  const h = harness();
  let active = [...baseline, "edit", "write", "bash", "grep", "glob", "todo_write", "archive_read"];
  h.pi.getActiveTools = () => [...active];
  h.pi.setActiveTools = (names: string[]) => { active = [...names]; };
  h.ctx.isIdle = () => true;
  h.ctx.getContextUsage = () => undefined;
  h.pi.sendMessage = (message: any) => h.sent.push(message.content);
  files(h.pi);
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

test("toggle swaps unprefixed tool schemas and restores the original selection", async () => {
  const h = setup(); await h.emit("session_start");
  expect(h.active().sort()).toEqual([...baseline, "archive_read"].sort());
  expect(h.tools.get("read").description).toContain("byte range");
  await h.command("minimax");
  expect(h.active()).toContain("bash");
  expect(h.active()).toContain("edit");
  expect(h.active()).not.toContain("shell");
  expect(h.active()).not.toContain("bg_process");
  expect(h.active()).not.toContain("sleep");
  expect(h.active()).not.toContain("ask_user");
  expect(h.active()).toContain("get_goal");
  expect(h.active()).toContain("swarm_task");
  for (const name of ["shell", "bg_process", "sleep", "ask_user", "unknown_tool"]) {
    expect((await h.emit("tool_call", { toolName: name }))[0].block).toBe(true);
  }
  for (const name of ["read", "bash", "get_goal", "swarm_task", "run_experiment"]) {
    expect(await h.emit("tool_call", { toolName: name })).toEqual([undefined]);
  }
  expect(h.active().some(name => name.startsWith("minimax_"))).toBe(false);
  expect(h.tools.get("read").description).not.toContain("byte range");
  await h.command("minimax", "on"); // Idempotent.
  await h.command("minimax", "off");
  expect(h.active().sort()).toEqual([...baseline, "archive_read"].sort());
  expect(h.tools.get("read").description).toContain("byte range");
  await expect(h.call("write", { path: "no", content: "no" })).rejects.toThrow("Enable /minimax");
  h.ctx.isIdle = () => false;
  await expect(h.command("minimax")).rejects.toThrow("Wait");
});

test("mode and todos follow the active session branch, including reload", async () => {
  const h = setup(); await h.emit("session_start"); await h.command("minimax", "on");
  const todos = [{ id: "a", content: "Verify the change", status: "in_progress" }];
  await h.call("todo_write", { todos });
  const branch = structuredClone(h.entries);
  h.entries.length = 0; await h.emit("session_switch");
  expect(h.active()).toContain("shell"); expect(h.active()).not.toContain("todo_write");
  h.entries.push(...branch); await h.emit("session_tree");
  expect(h.active()).toContain("todo_write");
  const prompt = (await h.emit("before_agent_start", { systemPrompt: "base" })).find(value => value?.systemPrompt);
  expect(prompt.systemPrompt).toContain("Verify the change");
  const fresh = setup(); fresh.entries.push(...branch); await fresh.emit("session_start");
  expect(fresh.active()).toContain("bash");
  await fresh.command("minimax", "off"); expect(fresh.active()).toContain("shell");
});

test("native file tools perform line reads, edits, writes, regex search, globs and bash", async () => {
  const h = setup(); h.ctx.cwd = await temp(); await h.emit("session_start"); await h.command("minimax", "on");
  await h.call("write", { path: "example.txt", content: "first\nsecond\nthird\n" });
  expect((await h.call("read", { path: "example.txt", offset: 2, limit: 1 })).content[0].text).toContain("second");
  await h.call("edit", { path: "example.txt", edits: [{ oldText: "second", newText: "changed" }] });
  expect(await readFile(join(h.ctx.cwd, "example.txt"), "utf8")).toBe("first\nchanged\nthird\n");
  expect((await h.call("grep", { path: ".", pattern: "ch.nged" })).content[0].text).toContain("changed");
  expect((await h.call("glob", { path: ".", pattern: "*.txt" })).content[0].text).toContain("example.txt");
  expect((await h.call("bash", { command: "printf verified", timeout: 2 })).content[0].text).toBe("verified");
  await expect(h.call("read", { path: "." })).rejects.toThrow("Not a regular file");
  await expect(h.call("read", { path: "example.txt", offset: 0 })).rejects.toThrow("positive line");
  await h.command("minimax", "off");
  expect((await h.call("read", { path: "example.txt", offset: 0, limit: 5 })).details.content).toBe("first");
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
  const h = setup(); await h.emit("session_start"); await h.command("minimax", "on");
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
  const h = setup(); await h.emit("session_start"); await h.command("minimax", "on");
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
  await h.command("minimax", "off"); expect(await h.emit("session_before_compact", compactionEvent())).toEqual([undefined]);
});

test("failed, truncated, empty and aborted checkpoints never replace the session", async () => {
  const h = setup(); await h.emit("session_start"); await h.command("minimax", "on");
  h.ctx.model = { maxTokens: 8192 };
  for (const stopReason of ["error", "aborted", "length", "stop"]) {
    h.ctx.modelRegistry = { complete: async () => ({ content: [], stopReason }) };
    expect(await h.emit("session_before_compact", compactionEvent())).toEqual([{ cancel: true }]);
  }
  h.ctx.modelRegistry = { complete: async () => { throw new Error("Network failure"); } };
  expect(await h.emit("session_before_compact", compactionEvent())).toEqual([{ cancel: true }]);
});

test("MiniMax takes precedence over pruner and Codex hooks without changing their saved settings", async () => {
  const h = setup(); pruner(h.pi);
  let requests = 0;
  installCompaction(h.pi, async () => { requests++; throw new Error("Should not run"); });
  h.ctx.model = { provider: "openai-codex", id: "test" };
  await h.emit("session_start"); await h.command("pruner", "on");
  await h.command("codex-compact"); await h.command("minimax", "on");
  await expect(h.command("codex-compact")).rejects.toThrow("MiniMax mode owns compaction");
  const results = await h.emit("context", { messages: messages(5) });
  expect(results.at(-1)).toBeUndefined();
  expect(await h.emit("before_provider_request", { payload: { model: "test", input: [{ role: "user", content: "hello" }] } })).toEqual([undefined]);
  expect(requests).toBe(0);
  expect((await h.emit("session_before_compact", compactionEvent()))[1]).toBeUndefined();
  await h.command("minimax", "off");
  expect((await h.emit("session_before_compact", compactionEvent()))[1]).toEqual({ cancel: true });
  expect(h.entries.filter(entry => entry.customType === "rework:pruner").at(-1).data.enabled).toBe(true);
});

test("/threshold controls MiniMax automatic compaction and does not block manual or overflow recovery", async () => {
  const h = setup(); installCompaction(h.pi, async () => { throw new Error("Not Codex compaction"); });
  await h.emit("session_start"); await h.command("minimax", "on");
  let tokens: number | null = 99999, calls = 0;
  h.ctx.getContextUsage = () => ({ tokens });
  h.ctx.compact = (options: any) => { calls++; options.onComplete({}); };
  await h.emit("agent_settled"); expect(calls).toBe(0);
  tokens = 100000; await h.emit("agent_settled"); expect(calls).toBe(1);
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
  await h.command("minimax", "off"); tokens = 300000;
  await h.emit("agent_settled"); expect(calls).toBe(2);
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
