import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../../lib/harness.ts";
import install from "./index.ts";

test("/nvim --no-open writes active-branch Markdown without opening an editor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-nvim-export-"));
  try {
    const h = harness(); install(h.pi); h.ctx.cwd = directory;
    h.ctx.sessionManager.getLeafId = () => "answer";
    h.entries.push(
      { type: "message", id: "question", parentId: null, message: { role: "user", content: "Fix the parser", timestamp: 1 } },
      { type: "message", id: "answer", parentId: "question", message: { role: "assistant", content: [
        { type: "thinking", thinking: "Check token boundaries" },
        { type: "text", text: "Parser fixed" },
        { type: "toolCall", id: "call", name: "read", arguments: { path: "parser.ts" } },
      ], timestamp: 2 } },
    );
    const notices: string[] = [];
    h.ctx.ui.notify = (text: string) => notices.push(text);
    await h.command("nvim", "--no-open exports/session with spaces.md");
    const output = await readFile(join(directory, "exports/session with spaces.md"), "utf8");
    for (const text of ["# Pi Session Export", "Fix the parser", "Parser fixed", "<summary>Thinking</summary>", "### Tool call: read", '"path": "parser.ts"']) expect(output).toContain(text);
    expect(notices[0]).toContain("Wrote session export:");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
