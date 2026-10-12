import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { harness } from "../../lib/harness.ts";
import { THEN_RUN_FAILED } from "../action-fusion/index.ts";
import reducer, { JOURNAL_TYPE } from "./index.ts";
import { EVIDENCE_RECEIPT, RECEIPT_SCHEMA, sha256 } from "./receipt.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const luna = { provider: "openai", id: "gpt-6-luna", api: "fixture", maxTokens: 4000 };

// The model is the external boundary: reply with whatever receipt the test supplies.
async function setup(reply: (log: string) => unknown, options: { auth?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "reducer-"));
  dirs.push(dir);
  const h = harness();
  const requests: Context[] = [];
  h.ctx.sessionManager.getSessionDir = () => dir;
  h.ctx.modelRegistry = {
    find: (provider: string, id: string) => provider === "openai" && id === luna.id ? luna : undefined,
    hasConfiguredAuth: () => options.auth ?? true,
    getProvider: () => ({}),
    streamSimple: (_model: unknown, context: Context) => {
      requests.push(context);
      const input = (context.messages[0]!.content as any)[0].text as string;
      const log = input.slice(input.indexOf("<untrusted_log>\n") + 16, input.lastIndexOf("\n</untrusted_log>"));
      const message = { role: "assistant", provider: "openai", model: luna.id, api: "fixture", timestamp: 1, stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(reply(log)) }], usage } as AssistantMessage;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  };
  reducer(h.pi);
  const run = async (event: any) => (await h.emit("tool_result", { toolCallId: "call", isError: false, details: undefined, ...event }))[0];
  return { dir, h, requests, run };
}

const noise = Array.from({ length: 200 }, (_, index) => `collected test_${index} PASSED`).join("\n");
const failingLog = `${noise}\nFAILED tests/test_core.py::test_parse - AssertionError: expected 3\n${noise}`;
const receipt = (log: string, evidence: Array<{ kind: string; quote: string }>, status = "failure") =>
  ({ schema: RECEIPT_SCHEMA, source_sha256: sha256(log), status, uncertain: false, evidence });
const bash = (text: string, extra: object = {}) =>
  ({ toolName: "bash", input: { command: "pytest -q" }, content: [{ type: "text", text }], isError: true, ...extra });

test("a long failing test log becomes a verified receipt", async () => {
  const { dir, h, run } = await setup(log => receipt(log, [{ kind: "failure", quote: "FAILED tests/test_core.py::test_parse - AssertionError: expected 3" }]));
  const result = await run(bash(failingLog));
  const text = result.content[0].text as string;
  expect(text.split("\n")[0]).toBe(EVIDENCE_RECEIPT);
  expect(text).toContain("- kind=failure line=201");
  expect(text).toContain("reducer_model=openai/gpt-6-luna");
  expect(result.details.evidencePreservingReducer).toMatchObject({ evidenceCount: 1, sourceSha256: sha256(failingLog) });
  const artifact = text.match(/source_artifact=(.+)/)![1]!;
  expect(artifact.startsWith(dir)).toBe(true);
  expect(await readFile(artifact, "utf8")).toBe(failingLog);
  expect(h.entries.at(-1)).toMatchObject({ customType: JOURNAL_TYPE, data: { kind: "applied" } });
});

test("a quote that is not in the log keeps the original output", async () => {
  const { h, run } = await setup(log => receipt(log, [{ kind: "failure", quote: "FAILED tests/test_other.py" }]));
  expect(await run(bash(failingLog))).toBeUndefined();
  expect(h.entries.at(-1).data).toMatchObject({ kind: "fallback", reason: "unverifiable-quote" });
});

test("a failing log needs failure evidence", async () => {
  const { h, run } = await setup(log => receipt(log, [{ kind: "summary", quote: "collected test_0 PASSED" }]));
  expect(await run(bash(failingLog))).toBeUndefined();
  expect(h.entries.at(-1).data.reason).toBe("missing-failure-evidence");
});

test("the receipt status must match the tool result", async () => {
  const { h, run } = await setup(log => receipt(log, [], "success"));
  expect(await run(bash(failingLog))).toBeUndefined();
  expect(h.entries.at(-1).data.reason).toBe("schema-mismatch");
});

test("short, non-diagnostic, and secret-bearing output is never sent", async () => {
  const { h, requests, run } = await setup(() => ({}));
  expect(await run(bash("FAILED quickly"))).toBeUndefined();
  expect(await run({ ...bash(failingLog), input: { command: "ls -la" } })).toBeUndefined();
  expect(await run(bash(`${failingLog}\nAPI_KEY=hunter2`))).toBeUndefined();
  expect(requests).toHaveLength(0);
  expect(h.entries.at(-1).data.reason).toBe("likely-secret");
});

test("without Luna the output stays unchanged", async () => {
  const { h, run } = await setup(() => ({}), { auth: false });
  expect(await run(bash(failingLog))).toBeUndefined();
  expect(h.entries.at(-1).data.reason).toBe("model-call-failed");
});

test("the reducer checks quotes against Bash's full output file", async () => {
  const path = join(tmpdir(), `pi-bash-${process.pid}-reducer.log`);
  await writeFile(path, failingLog);
  try {
    const { requests, run } = await setup(log => receipt(log, [{ kind: "failure", quote: "AssertionError: expected 3" }]));
    const result = await run(bash(`${noise}\n\n[Showing lines 1-200. Full output: ${path}]`, { details: { fullOutputPath: path } }));
    expect(result.content[0].text).toContain(`source_sha256=${sha256(failingLog)}`);
    expect((requests[0]!.messages[0]!.content as any)[0].text).toContain("AssertionError: expected 3");
  } finally {
    await rm(path, { force: true });
  }
});

test("a fused edit keeps its edit output and replaces only the command output", async () => {
  const { run } = await setup(log => receipt(log, [{ kind: "failure", quote: "AssertionError: expected 3" }]));
  const result = await run({
    toolName: "edit",
    input: { path: "a.py", then_run: { command: "cd app && pytest" } },
    content: [{ type: "text", text: "Successfully replaced text in a.py." }, { type: "text", text: `${THEN_RUN_FAILED}\n${failingLog}` }],
    details: { diff: "-a\n+b" },
    isError: true,
  });
  expect(result.content[0].text).toBe("Successfully replaced text in a.py.");
  expect(result.content[1].text.startsWith(`${THEN_RUN_FAILED}\n${EVIDENCE_RECEIPT}\n`)).toBe(true);
  expect(result.details.diff).toBe("-a\n+b");
});
