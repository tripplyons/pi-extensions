import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { harness } from "../../lib/harness.ts";
import { historyPage, readHistory } from "../../lib/session-history.ts";
import install from "./index.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function reply(session: SessionManager, text: string, extra: any[] = []) {
  return session.appendMessage({ role: "assistant", content: [...extra, { type: "text", text }], api: "openai-responses", provider: "openai", model: "test", usage, stopReason: "stop", timestamp: Date.now() });
}
async function fixture(check: (h: ReturnType<typeof harness>, root: string, session: SessionManager, directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-session-search-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  const directory = join(root, "custom-sessions"), session = SessionManager.create(join(root, "project"), directory);
  const h = harness(); h.ctx.sessionManager = session; h.ctx.cwd = session.getCwd(); h.ctx.mode = "tui";
  install(h.pi);
  try { await check(h, root, session, directory); }
  finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
}

test("search discovers real Pi files in a custom directory, defaults to exact project, and all scope is explicit", () => fixture(async (h, root, current, directory) => {
  const local = SessionManager.create(current.getCwd(), directory);
  local.appendSessionInfo("Queue decisions"); local.appendMessage({ role: "user", content: "Why queued compaction?", timestamp: Date.now() });
  const entryId = reply(local, "Queued input waits for compaction.");
  const other = SessionManager.create(join(root, "other"), directory); reply(other, "Queued compaction elsewhere.");
  const standard = SessionManager.create(join(root, "standard")); reply(standard, "Queued compaction in standard storage.");
  current.appendMessage({ role: "user", content: "Unflushed live keyword", timestamp: Date.now() });
  const found = await h.call("session_search", { query: "QUEUED compaction" });
  expect(found.details.total).toBe(2);
  expect(found.details.matches.every((match: any) => match.sessionId === local.getSessionId())).toBe(true);
  expect(found.structuredContent.matches[0]).toMatchObject({ sessionId: local.getSessionId(), entryId, name: "Queue decisions", activeBranch: true });
  const all = (await h.call("session_search", { query: "queued compaction", scope: "all" })).details;
  expect(all.total).toBe(4);
  expect(all.matches.some((match: any) => match.sessionId === standard.getSessionId())).toBe(true);
  await expect(h.call("session_read", { sessionId: other.getSessionId() })).rejects.toThrow("not found in this scope");
  expect((await h.call("session_read", { sessionId: other.getSessionId(), scope: "all" })).details.records[0].text).toContain("elsewhere");
  expect((await h.call("session_search", { query: "unflushed" })).details.matches[0].sessionId).toBe(current.getSessionId());
  expect(h.sentMessages).toEqual([]); expect(h.sent).toEqual([]);
}));

test("raw originals survive compaction and context edits; alternate branches are labeled and never interleaved", () => fixture(async (h, _root, current, directory) => {
  const session = SessionManager.create(current.getCwd(), directory);
  const first = session.appendMessage({ role: "user", content: "original zebra decision", timestamp: Date.now() });
  const abandoned = reply(session, "abandoned zebra approach");
  session.branch(first);
  const chosen = reply(session, "chosen zebra approach");
  const kept = session.appendMessage({ role: "user", content: "next task", timestamp: Date.now() });
  const summary = session.appendCompaction("zebra summary", kept, 10000);
  session.appendContextEdit(first, null);
  reply(session, "Now compacted");
  const original = await readFile(session.getSessionFile()!, "utf8");
  const search = (await h.call("session_search", { query: "zebra" })).details;
  expect(search.matches.find((item: any) => item.entryId === abandoned).activeBranch).toBe(false);
  expect(search.matches.find((item: any) => item.entryId === chosen).activeBranch).toBe(true);
  expect(search.matches.some((item: any) => item.entryId === first)).toBe(true);
  const span = (await h.call("session_read", { sessionId: session.getSessionId(), entryId: abandoned })).details;
  expect(span.records.map((item: any) => item.entryId)).toEqual([first, abandoned]);
  const expanded = (await h.call("session_read", { sessionId: session.getSessionId(), entryId: summary, expandSummary: true })).details;
  expect(expanded.records.map((item: any) => item.entryId)).toEqual([first, chosen]);
  expect(expanded.source).toMatchObject({ summaryEntryId: summary, firstEntryId: first, lastEntryId: chosen });
  expect(expanded.notice).toContain("not current instructions or permission");
  expect(await readFile(session.getSessionFile()!, "utf8")).toBe(original);
}));

test("tool search is opt-in, private thinking and state stay excluded, literal search is not regex", () => fixture(async (h, _root, current, directory) => {
  const session = SessionManager.create(current.getCwd(), directory);
  reply(session, "plain text [literal]", [{ type: "thinking", thinking: "hidden secretword", thinkingSignature: "secret" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "toolneedle" } }]);
  session.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text: "outputneedle" }], isError: false, timestamp: Date.now() });
  session.appendCustomEntry("private", { secret: "stateword" });
  session.appendMessage({ role: "system", content: "systemword", timestamp: Date.now() });
  for (const query of ["secretword", "stateword", "systemword", ".*"]) expect((await h.call("session_search", { query, includeTools: true })).details.total).toBe(0);
  for (const query of ["toolneedle", "outputneedle"]) {
    expect((await h.call("session_search", { query })).details.total).toBe(0);
    expect((await h.call("session_search", { query, includeTools: true })).details.total).toBe(1);
  }
  expect((await h.call("session_search", { query: "[literal]" })).details.total).toBe(1);
  const read = (await h.call("session_read", { sessionId: session.getSessionId() })).details;
  expect(JSON.stringify(read)).not.toMatch(/secretword|stateword|systemword/);
  expect(JSON.stringify(read)).toContain("toolneedle");
}));

test("search and message reads page without losing stable IDs, and large entry chunks are recoverable", () => fixture(async (h, _root, current, directory) => {
  const session = SessionManager.create(current.getCwd(), directory), ids: string[] = [];
  for (let i = 0; i < 55; i++) ids.push(reply(session, `needle ${i}`));
  const first = (await h.call("session_search", { query: "needle", limit: 10 })).details;
  const second = (await h.call("session_search", { query: "needle", limit: 10, offset: first.nextOffset })).details;
  expect(first.total).toBe(55); expect(first.nextOffset).toBe(10);
  expect(second.matches.some((item: any) => first.matches.some((prior: any) => prior.entryId === item.entryId))).toBe(false);
  const tail = (await h.call("session_read", { sessionId: session.getSessionId(), limit: 10 })).details;
  const older = (await h.call("session_read", { sessionId: session.getSessionId(), limit: 10, beforeEntryId: tail.nextBeforeEntryId })).details;
  expect(tail.records.map((item: any) => item.entryId)).toEqual(ids.slice(-10));
  expect(older.records.map((item: any) => item.entryId)).toEqual(ids.slice(-20, -10));
  const large = reply(session, "x".repeat(9000) + "END");
  const chunk = (await h.call("session_read", { sessionId: session.getSessionId(), entryId: large, limit: 1 })).details.records[0];
  expect(chunk.text).toHaveLength(4000); expect(chunk.nextTextOffset).toBe(4000);
  const last = (await h.call("session_read", { sessionId: session.getSessionId(), entryId: large, textOffset: 8000, limit: 1 })).details.records[0];
  expect(last.text.endsWith("END")).toBe(true); expect(last.nextTextOffset).toBeNull();
  const many = (await h.call("session_read", { sessionId: session.getSessionId(), limit: 50 })).details;
  expect(many.records.reduce((sum: number, item: any) => sum + item.text.length, 0)).toBeLessThanOrEqual(28000);
}));

test("branch-summary expansion follows the abandoned source branch and retain-none compaction covers all ancestors", () => fixture(async (_h, _root, current, directory) => {
  const session = SessionManager.create(current.getCwd(), directory);
  const common = reply(session, "common"), old = reply(session, "old branch");
  const summary = session.branchWithSummary(common, "old branch summary");
  reply(session, "new branch");
  const history = await readHistory(session.getSessionFile()!);
  expect(historyPage(history, { entryId: summary, expandSummary: true }).records.map(item => item.entryId)).toEqual([old]);
  const compaction = session.appendCompaction("everything", "unused", 1000);
  const content = await readFile(session.getSessionFile()!, "utf8");
  const lines = content.trim().split("\n").map(JSON.parse);
  lines.find(entry => entry.id === compaction).firstKeptEntryId = compaction;
  await writeFile(session.getSessionFile()!, lines.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const all = historyPage(await readHistory(session.getSessionFile()!), { entryId: compaction, expandSummary: true });
  expect(all.records.some(item => item.entryId === common)).toBe(true);
  expect(all.records.some(item => item.entryId === old)).toBe(false);
}));

test("legacy reads are stable and never migrate files; partial trailing writes are reported", () => fixture(async (h, _root, current, directory) => {
  const path = join(directory, "legacy.jsonl");
  const content = [
    { type: "session", version: 1, id: "legacy", cwd: current.getCwd(), timestamp: new Date().toISOString() },
    { type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "legacy needle", timestamp: Date.now() } },
    { type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "legacy answer" }], timestamp: Date.now() } },
  ].map(entry => JSON.stringify(entry)).join("\n") + '\n{"type":';
  await writeFile(path, content);
  const found = (await h.call("session_search", { query: "legacy needle" })).details;
  expect(found.matches[0].entryId).toBe("legacy-1");
  expect(found.warnings).toContain("legacy: Skipped 1 malformed or incomplete lines.");
  const page = (await h.call("session_read", { sessionId: "legacy", entryId: found.matches[0].entryId })).details;
  expect(page.records[0].text).toBe("legacy needle");
  expect(await readFile(path, "utf8")).toBe(content);
}));

test("rejects invalid requests, unknown entry IDs, arbitrary paths, ambiguous IDs and aborted calls", () => fixture(async (h, _root, current, directory) => {
  const session = SessionManager.create(current.getCwd(), directory); reply(session, "needle");
  for (const args of [{ query: " " }, { query: "needle", limit: 0 }, { query: "needle", offset: -1 }, { query: "needle", scope: "bad" }]) await expect(h.call("session_search", args)).rejects.toThrow();
  for (const args of [{ entryId: "missing" }, { limit: 51 }, { beforeEntryId: "missing" }, { textOffset: 1 }, { expandSummary: true }]) await expect(h.call("session_read", { sessionId: session.getSessionId(), ...args })).rejects.toThrow();
  await expect(h.call("session_read", { sessionId: "/etc/passwd" })).rejects.toThrow("not found");
  await writeFile(join(directory, "duplicate.jsonl"), await readFile(session.getSessionFile()!, "utf8"));
  await expect(h.call("session_read", { sessionId: session.getSessionId() })).rejects.toThrow("Ambiguous");
  const controller = new AbortController(); controller.abort();
  await expect(h.call("session_search", { query: "needle" }, controller.signal)).rejects.toThrow();
}));

test("interactive search opens a read-only screen; cancellation and non-TUI modes do not inject messages", () => fixture(async (h, _root, current, directory) => {
  const session = SessionManager.create(current.getCwd(), directory); reply(session, "inspector needle");
  let selections = 0, viewed = false;
  h.ctx.ui.select = async (_title: string, choices: string[]) => selections++ === 0 ? choices[0] : undefined;
  h.ctx.ui.custom = async (factory: any) => {
    let action;
    const component = factory({ terminal: { rows: 20 }, requestRender() {} }, { fg: (_color: string, value: string) => value }, {}, (value: any) => { action = value; });
    expect(component.render(30).join("\n")).toContain("Archived evidence");
    component.handleInput("\x1b"); viewed = true; return action;
  };
  await h.command("session-search", "inspector");
  expect(viewed).toBe(true); expect(h.sentMessages).toEqual([]); expect(h.sent).toEqual([]);
  h.ctx.mode = "rpc";
  await h.command("session-search", "inspector");
  expect(h.sentMessages).toEqual([]);
}));
