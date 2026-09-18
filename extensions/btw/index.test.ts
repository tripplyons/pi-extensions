import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import { installBtw } from "./index.ts";

for (const tools of [false, true]) test(`/btw${tools ? ":tools" : ""} copies the saved session and removes its temporary session`, async () => {
  const h = harness();
  h.ctx.model = { provider: "openai-codex", id: "test-model" };
  const directory = mkdtempSync(join(tmpdir(), "btw-test-"));
  const source = join(directory, "session.jsonl");
  writeFileSync(source, '{"type":"session","id":"parent"}\n{"type":"message","message":{"role":"user","content":"context"}}\n');
  h.ctx.sessionManager.getSessionFile = () => source;
  h.ctx.ui.custom = async () => undefined;
  h.pi.registerMessageRenderer = () => {};
  h.pi.getActiveTools = () => ["read", "shell"];
  h.pi.getThinkingLevel = () => "high";
  let args: string[] = [];
  let session = "";
  let env: any;
  let resolveReply!: () => void;
  const replied = new Promise<void>(resolve => { resolveReply = resolve; });
  h.pi.sendMessage = (message: any) => { expect(message.content).toBe("Side answer"); resolveReply(); };
  installBtw(h.pi, ((_command: string, argv: string[], options: any) => {
    env = options.env;
    args = argv;
    session = args[args.indexOf("--session") + 1];
    const entries = readFileSync(session, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries[0].type).toBe("session");
    expect(entries[1].message.content).toBe("context");
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Side answer" }] } }) + "\n");
      child.emit("close", 0);
    });
    return child;
  }) as any);
  try {
    await h.command(tools ? "btw:tools" : "btw", "Side question");
    await replied;
    expect(args.at(-1)).toContain("Side question");
    expect(env.PI_BTW_BLOCK_TOOLS).toBe(tools ? "" : "1");
    expect(args).toContain("openai-codex/test-model:high");
    expect(existsSync(session)).toBe(false);
    expect(h.entries).toHaveLength(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
